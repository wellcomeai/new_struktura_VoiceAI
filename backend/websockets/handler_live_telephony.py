"""
Телефонный мост GPT-Live: Voximplant WebSocket ⇄ gpt-live-1 (экспериментально).

Маршрут /ws/live/telephony/{assistant_id}. Сценарий voximplant_scenarios/inbound_live.js
открывает ОДИН WebSocket и гоняет по нему аудио в обе стороны:
call.sendMediaTo(ws) → нам, ws.sendMediaTo(call) → в трубку. Сессия GPT-Live
живёт здесь, на сервере. VAD и синтез — внутри модели: она сама решает, когда
замолчать при перебивании. Но о своём решении она не сообщает — в GPT-Live нет
события конца или прерывания реплики (гайд: "no timing fields or output-audio-done
event"), — а уже сгенерированное аудио к этому моменту лежит в наших буферах.
Гасим его сами: см. _maybe_barge_in / _flush_output.

Протокол (сценарий → сервер):
  {type:"call_started", call_id, caller_number, called_number, chat_id,
   first_phrase, system_prompt, session_history_id,
   audio:{encoding:"PCM16", sampleRate:16000}}        — ещё до ответа на звонок:
   по нему сразу поднимаем сессию Live (2 с уходят на гудки, а не на тишину)
  {event:"start", start:{mediaFormat:{encoding:"PCM16", sampleRate:16000}}}
  {event:"media", media:{payload:<base64>}}
  {event:"stop"} / {type:"call_ended"}
Протокол (сервер → сценарий):
  {type:"connection_status", status:"connected"}
  {event:"start", start:{mediaFormat:{encoding, sampleRate}}}  — перед первым кадром
  {event:"media", sequenceNumber, media:{timestamp, chunk, payload}}
  {type:"live.started", session_id, voice, backend_model, functions}
  {type:"function_call"|"function_result", ...}
  {type:"barge_in"}                                  — абонент перебил ассистента:
   сценарий зовёт ws.clearMediaBuffer() и гасит уже отправленное в Voximplant аудио
  {type:"call_summary", dialog:[{role,text,ts}], usage_seconds, session_id,
   serve_ms, gen_speed_x10, model_ms, speech_end_epoch — замеры задержки}
  {type:"error", error:{code, message}}

Диалог в conversations пишет сценарий через /api/voximplant/log (там же запись
в R2, Telegram, списание по длительности) — мы отдаём ему транскрипт в
call_summary. Если сокет оборвался раньше — сохраняем сами, чтобы не потерять.

hangup_call пока не поддерживается (функция исключается из tools).
"""
import asyncio
import audioop
import base64
import json
import re
import time
import uuid
from typing import Any, Dict, List, Optional

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from backend.core.logging import get_logger
from backend.db.session import SessionLocal
from backend.models.assistant import AssistantConfig
from backend.models.user import User
from backend.services import provider_keys
from backend.services.conversation_service import ConversationService
from backend.services.user_service import UserService
from backend.websockets.handler_live import TranscriptCollector
from backend.websockets.live_client import OpenAILiveClient, LIVE_MODEL

logger = get_logger(__name__)

LIVE_RATE = 16000          # GPT-Live принимает pcm 16 кГц напрямую — без ресемплинга
FRAME_MS = 20              # рекомендованный докой шаг медиа-кадра
LEAD_LIMIT_MS = 1500       # насколько убегаем вперёд буфера Voximplant (лимит 10 с);
                           # при перебивании этот запас гасит clearMediaBuffer()
BARGE_IN_MUTE_MS = 200     # окно после перебивания, в котором выбрасываем
                           # долетающие дельты уже прерванной реплики
BARGE_IN_COOLDOWN_MS = 1000  # не перебиваем повторно: одна фраза абонента даёт
                             # десятки фрагментов транскрипта, реагируем на первый
BARGE_IN_MIN_TAIL_MS = 400   # если ассистенту осталось договорить меньше этого,
                             # не рубим — дешевле дать фразе закончиться
REPLY_GAP_SEC = 0.5          # пауза в потоке дельт, после которой считаем, что
                             # началась новая реплика (для замеров ниже)

# VAD для замера «конец речи абонента → первый звук модели». Параметры один в один
# как в backend/static/live-test.html, иначе телефонное число не сравнить с
# браузерным (там медиана 359 мс).
VAD_HANG_MS = 300            # столько тишины считаем концом фразы
VAD_FLOOR_MIN = 0.008        # нижняя граница порога (амплитуда 0..1)
VAD_FLOOR_MULT = 5
SUMMARY_WAIT_SEC = 3.0

# Кодек в StartEvent для Voximplant: имена из WebSocketAudioEncoding
# (см. комментарий в handler_fish_tts.py — "PCM16" @ 8000 Voximplant отвергает).
PCM_ENCODING_BY_RATE = {8000: "PCM8", 16000: "PCM16"}
EXCLUDED_FUNCTIONS = ["hangup_call"]


def _median(values: List[int]) -> Optional[int]:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def _extract_caller_name(system_prompt: str) -> Optional[str]:
    """Из карточки звонящего (/api/telephony/config) достаём только имя для голосового слоя."""
    if not system_prompt:
        return None
    m = re.search(r"^Имя:\s*(.+?)\s*$", system_prompt, re.MULTILINE)
    return m.group(1).strip() if m else None


class LiveTelephonyBridge:
    def __init__(self, websocket: WebSocket, assistant_id: str, db: Session):
        self.ws = websocket
        self.assistant_id = assistant_id
        self.db = db
        self.client_id = f"livetel_{uuid.uuid4().hex[:10]}"

        self.assistant: Optional[AssistantConfig] = None
        self.api_key: Optional[str] = None
        self.live: Optional[OpenAILiveClient] = None

        # Данные звонка от сценария
        self.call_id = "unknown"
        self.caller_number = "unknown"
        self.called_number = "unknown"
        self.chat_id: Optional[str] = None
        self.first_phrase: Optional[str] = None
        self.config_prompt: Optional[str] = None
        self.session_history_id: Optional[str] = None

        # Входящее аудио от Voximplant
        self.vox_encoding = "PCM16"
        self.vox_rate = 16000
        self.in_state = None            # состояние audioop.ratecv
        self.stream_in_started = False  # Voximplant прислал StartEvent = медиа привязано
        self.greeted = False

        # Исходящее аудио в Voximplant
        self.out_queue: asyncio.Queue = asyncio.Queue()
        self.stream_out_started = False
        self.sequence = 0
        self.chunk = 0
        self.samples_sent = 0
        self.play_end_time = 0.0
        self.out_state = None
        self.frames_sent = 0
        self.out_pending = bytearray()   # недобранный кадр (<20 мс), гасится при перебивании
        self.mute_until = 0.0            # до какого момента игнорируем дельты
        self.barge_ins = 0
        self.barge_in_dropped_ms = 0
        self.barge_in_cooldown_until = 0.0

        # Замеры задержки. serve_ms — сколько наш сервер держал реплику от первой
        # дельты модели до первого кадра, ушедшего в Voximplant: это ровно наш
        # вклад в задержку, без телефонной сети. gen_speed_x10 — во сколько раз
        # (×10) модель отдала аудио быстрее реального времени.
        self.reply_t0 = 0.0
        self.reply_bytes = 0
        self.last_delta_at = 0.0
        self.awaiting_first_frame = False
        self.serve_ms: List[int] = []
        self.gen_speed_x10: List[int] = []

        # model_ms — «конец речи абонента → первый звук модели», прямой аналог
        # браузерного замера. speech_end_epoch — те же моменты в абсолютном времени:
        # сверив их с записью, видно, с каким лагом звук абонента вообще до нас
        # доезжает (единственный неизмеренный участок цепочки).
        self.vad_speaking = False
        self.vad_silence_since = 0.0
        self.vad_noise_floor = 0.002
        self.speech_end_at = 0.0
        self.awaiting_model = False
        self.model_ms: List[int] = []
        self.speech_end_epoch: List[int] = []

        self.transcript = TranscriptCollector()
        self.started_at = time.time()
        self.stop_event = asyncio.Event()
        self.ws_closed = False
        self.summary_sent = False
        self.usage_seconds: Optional[int] = None

    # ------------------------------------------------------------------
    def log(self, msg: str, level: str = "info"):
        getattr(logger, level)(f"[LIVE-TEL {self.client_id}] {msg}")

    async def send_json(self, payload: Dict[str, Any]) -> bool:
        if self.ws_closed:
            return False
        try:
            await self.ws.send_text(json.dumps(payload, ensure_ascii=False))
            return True
        except Exception:
            self.ws_closed = True
            return False

    async def send_error(self, code: str, message: str):
        await self.send_json({"type": "error", "error": {"code": code, "message": message}})

    # ------------------------------------------------------------------
    async def start(self):
        try:
            await self.ws.accept()
            self.log(f"connected for assistant {self.assistant_id}")

            if not await self._prepare():
                return
            await self.send_json({"type": "connection_status", "status": "connected", "model": LIVE_MODEL})

            reader = asyncio.create_task(self._read_scenario())
            await self.stop_event.wait()
            await self._finish()
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
        except Exception as e:
            self.log(f"fatal: {e}", "error")
        finally:
            try:
                await self.ws.close()
            except Exception:
                pass

    async def _prepare(self) -> bool:
        try:
            self.assistant = self.db.query(AssistantConfig).filter(AssistantConfig.id == uuid.UUID(self.assistant_id)).first()
        except (ValueError, Exception) as e:
            self.log(f"assistant lookup failed: {e}", "error")
            self.assistant = None
        if self.assistant is None:
            await self.send_error("assistant_not_found", "Assistant not found")
            return False

        owner = self.db.query(User).filter(User.id == self.assistant.user_id).first() if self.assistant.user_id else None
        if owner is not None and not owner.is_admin:
            try:
                sub = UserService.check_subscription_status(self.db, str(owner.id))
                if not sub.get("active"):
                    await self.send_error("subscription_expired", "Subscription expired")
                    return False
            except Exception as e:
                self.log(f"subscription check failed (continuing): {e}", "warning")
        self.api_key = provider_keys.resolve(owner, "openai").api_key
        if not self.api_key:
            await self.send_error("no_api_key", "Missing OpenAI API key")
            return False
        return True

    # ------------------------------------------------------------------
    # Сценарий → сервер
    # ------------------------------------------------------------------
    async def _read_scenario(self):
        try:
            while not self.stop_event.is_set():
                raw = await self.ws.receive_text()
                try:
                    data = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                mtype, event = data.get("type"), data.get("event")
                if mtype == "call_started":
                    self._on_call_started(data)
                elif event == "start":
                    await self._on_stream_start(data)
                elif event == "media":
                    await self._on_media(data)
                elif event == "stop":
                    self.log("media stream stopped by Voximplant")
                elif mtype == "call_ended":
                    self.log("call_ended from scenario")
                    self.stop_event.set()
                elif mtype == "ping":
                    await self.send_json({"type": "pong"})
        except WebSocketDisconnect:
            self.ws_closed = True
            self.log("scenario socket disconnected")
        except Exception as e:
            self.ws_closed = True
            self.log(f"reader error: {e}", "error")
        finally:
            self.stop_event.set()

    def _on_call_started(self, data: Dict[str, Any]):
        self.call_id = str(data.get("call_id") or self.call_id)
        self.caller_number = str(data.get("caller_number") or self.caller_number)
        self.called_number = str(data.get("called_number") or self.called_number)
        self.chat_id = data.get("chat_id") or self.chat_id
        self.first_phrase = (data.get("first_phrase") or "").strip() or None
        self.config_prompt = (data.get("system_prompt") or "").strip() or None
        self.session_history_id = data.get("session_history_id")
        audio = data.get("audio") or {}
        self.vox_encoding = str(audio.get("encoding") or self.vox_encoding).upper()
        self.vox_rate = int(audio.get("sampleRate") or self.vox_rate)
        self.log(f"call_started: from={self.caller_number} to={self.called_number} call_id={self.call_id} "
                 f"first_phrase={'yes' if self.first_phrase else 'no'} config_prompt={len(self.config_prompt or '')} chars "
                 f"audio={self.vox_encoding}@{self.vox_rate}")
        # Pre-answer: сессию Live поднимаем сразу, пока абонент слышит гудки.
        # Сценарий ответит на звонок по нашему live.started.
        if self.live is None:
            asyncio.create_task(self._connect_live())

    async def _on_stream_start(self, data: Dict[str, Any]):
        fmt = (data.get("start") or {}).get("mediaFormat") or {}
        enc = str(fmt.get("encoding") or "PCM16").upper()
        rate = int(fmt.get("sampleRate") or 16000)
        if self.live is not None and (enc, rate) != (self.vox_encoding, self.vox_rate):
            self.log(f"Voximplant format {enc}@{rate} differs from call_started {self.vox_encoding}@{self.vox_rate}; "
                     f"converting", "warning")
        self.vox_encoding, self.vox_rate = enc, rate
        self.stream_in_started = True
        self.log(f"stream start from Voximplant: {enc} @ {rate} Hz (media attached)")
        if self.live is None:
            # Сценарий без pre-answer (старый порядок) — поднимаем сессию здесь
            await self._connect_live()
        await self._maybe_greet()

    async def _maybe_greet(self):
        """Приветствие — только когда и сессия Live готова, и медиа в звонок привязано."""
        if self.greeted or self.live is None or not self.live.is_connected or not self.stream_in_started:
            return
        self.greeted = True
        greeting = self.first_phrase or (getattr(self.assistant, "greeting_message", None) or "").strip()
        if greeting:
            await self.live.say_greeting(greeting)
            self.log(f"greeting requested: \"{greeting[:60]}\"")

    async def _on_media(self, data: Dict[str, Any]):
        if self.live is None or not self.live.is_connected:
            return
        payload = (data.get("media") or {}).get("payload") or ""
        if not payload:
            return
        try:
            raw = base64.b64decode(payload)
        except Exception:
            return
        pcm = self._to_live_pcm(raw)
        if pcm:
            self._vad_feed(pcm)
            await self.live.send_audio(pcm)

    def _to_live_pcm(self, raw: bytes) -> bytes:
        """Кадр Voximplant → PCM16 @ LIVE_RATE."""
        enc = self.vox_encoding
        if enc == "ULAW":
            pcm, rate = audioop.ulaw2lin(raw, 2), 8000
        elif enc == "ALAW":
            pcm, rate = audioop.alaw2lin(raw, 2), 8000
        else:
            pcm, rate = raw, self.vox_rate
        if rate != LIVE_RATE:
            pcm, self.in_state = audioop.ratecv(pcm, 2, 1, rate, LIVE_RATE, self.in_state)
        return pcm

    def _from_live_pcm(self, pcm: bytes) -> bytes:
        """PCM16 @ LIVE_RATE → кадр в кодеке/частоте Voximplant."""
        enc = self.vox_encoding
        target_rate = 8000 if enc in ("ULAW", "ALAW") else self.vox_rate
        if target_rate != LIVE_RATE:
            pcm, self.out_state = audioop.ratecv(pcm, 2, 1, LIVE_RATE, target_rate, self.out_state)
        if enc == "ULAW":
            return audioop.lin2ulaw(pcm, 2)
        if enc == "ALAW":
            return audioop.lin2alaw(pcm, 2)
        return pcm

    # ------------------------------------------------------------------
    # GPT-Live
    # ------------------------------------------------------------------
    def _voice_extra(self) -> str:
        msk = time.strftime("%Y-%m-%d %H:%M", time.gmtime(time.time() + 3 * 3600))
        lines = ["Это телефонный звонок, ты отвечаешь на входящий вызов.",
                 f"Номер клиента: {self.caller_number}. Наш номер: {self.called_number}. "
                 f"Текущее время: {msk} (МСК)."]
        name = _extract_caller_name(self.config_prompt or "")
        if name:
            lines.append(f"Звонит известный клиент, его зовут {name}. Обращайся по имени.")
        return "\n".join(lines)

    async def _connect_live(self):
        self.live = OpenAILiveClient(
            self.api_key, self.assistant, self.client_id, db_session=self.db,
            audio_rate=LIVE_RATE,
            backend_user_prompt=self.config_prompt,
            voice_extra_instructions=self._voice_extra(),
            exclude_functions=EXCLUDED_FUNCTIONS,
        )
        self.live.function_context_extra = {
            "call_data": {"call_id": self.call_id, "chat_id": self.chat_id,
                          "assistant_id": str(self.assistant.id), "caller_number": self.caller_number},
        }
        if not await self.live.connect():
            await self.send_error("live_connect_failed", "Failed to open gpt-live-1 session")
            self.stop_event.set()
            return
        await self.send_json({
            "type": "live.started", "session_id": self.live.session_id, "voice": self.live.voice,
            "backend_model": self.live.delegation_model, "functions": self.live.enabled_functions,
        })
        asyncio.create_task(self._pump_live_events())
        asyncio.create_task(self._pump_out_audio())
        await self._maybe_greet()

    async def _pump_live_events(self):
        try:
            async for event in self.live.receive_events():
                etype = event.get("type")
                if etype == "session.output_audio.delta":
                    if time.time() < self.mute_until:
                        continue          # хвост прерванной реплики — в трубку не отдаём
                    try:
                        pcm = base64.b64decode(event.get("delta") or "")
                    except Exception:
                        pcm = b""
                    if pcm:
                        self._note_model_audio()
                        self._note_delta(len(pcm))
                        self.out_queue.put_nowait(pcm)
                elif etype in ("session.input_transcript.delta", "session.output_transcript.delta"):
                    role = "user" if etype.startswith("session.input") else "assistant"
                    self.transcript.add(role, event.get("delta") or "", event.get("start_ms"), event.get("end_ms"))
                    if role == "user":
                        await self._maybe_barge_in(event.get("delta") or "")
                elif etype == "live.function_call":
                    self.log(f"function_call {event.get('name')} {str(event.get('arguments'))[:120]}")
                    await self.send_json({"type": "function_call", "name": event.get("name"),
                                          "arguments": event.get("arguments")})
                elif etype == "live.function_result":
                    await self.send_json({"type": "function_result", "name": event.get("name"),
                                          "result": event.get("result")})
                elif etype == "session.usage.updated":
                    self.usage_seconds = (event.get("usage") or {}).get("seconds", self.usage_seconds)
                elif etype == "session.closed":
                    self.usage_seconds = (event.get("usage") or {}).get("seconds", self.usage_seconds)
                    self.log(f"live session closed: reason={event.get('reason')} usage={self.usage_seconds}s")
                    self.stop_event.set()
                elif etype == "error":
                    err = event.get("error") or {}
                    self.log(f"live error: {err.get('code')} {err.get('message')}", "warning")
        except Exception as e:
            self.log(f"live event pump error: {e}", "error")
        finally:
            self.stop_event.set()

    # ------------------------------------------------------------------
    # Замеры задержки
    # ------------------------------------------------------------------
    def _vad_feed(self, pcm: bytes):
        """Ищем конец фразы абонента во входящем аудио — точка отсчёта для model_ms."""
        rms = audioop.rms(pcm, 2) / 32768.0
        thr = max(VAD_FLOOR_MIN, self.vad_noise_floor * VAD_FLOOR_MULT)
        now = time.time()
        if rms > thr:
            self.vad_speaking = True
            self.vad_silence_since = 0.0
            return
        # Порог двигаем ТОЛЬКО по тишине: если обновлять его и во время речи, он за
        # пару секунд догоняет голос и рвёт фразу на середине.
        self.vad_noise_floor = (rms * 0.1 + self.vad_noise_floor * 0.9
                                if rms < self.vad_noise_floor
                                else self.vad_noise_floor * 0.99 + rms * 0.01)
        if not self.vad_speaking:
            return
        if not self.vad_silence_since:
            self.vad_silence_since = now
        elif (now - self.vad_silence_since) * 1000 >= VAD_HANG_MS:
            # Точка отсчёта — когда звук пропал, а не когда мы это заметили.
            self.vad_speaking = False
            self.speech_end_at = self.vad_silence_since
            self.vad_silence_since = 0.0
            self.awaiting_model = True
            self.speech_end_epoch.append(int(self.speech_end_at * 1000))

    def _note_model_audio(self):
        """Первый звук модели после того, как абонент замолчал."""
        if not self.awaiting_model:
            return
        self.awaiting_model = False
        ms = int((time.time() - self.speech_end_at) * 1000)
        if ms < 20 or ms > 15000:
            return
        self.model_ms.append(ms)
        self.log(f"модель ответила через {ms} мс после конца речи абонента "
                 f"(медиана {_median(self.model_ms)} по {len(self.model_ms)})")

    def _note_delta(self, nbytes: int):
        """Пришёл кусок аудио от модели. Пауза дольше REPLY_GAP_SEC = новая реплика."""
        now = time.time()
        if now - self.last_delta_at > REPLY_GAP_SEC:
            self._close_reply()
            self.reply_t0 = now
            self.reply_bytes = 0
            self.awaiting_first_frame = True
        self.last_delta_at = now
        self.reply_bytes += nbytes

    def _close_reply(self):
        """Реплика кончилась — считаем, насколько модель обогнала реальное время."""
        audio_ms = (self.reply_bytes // 2) * 1000 // LIVE_RATE
        if self.reply_t0 and audio_ms >= 200:
            gen_ms = max(1, int((self.last_delta_at - self.reply_t0) * 1000))
            self.gen_speed_x10.append(audio_ms * 10 // gen_ms)
        self.reply_t0 = 0.0
        self.reply_bytes = 0

    def _note_first_frame(self):
        """Первый кадр реплики ушёл в Voximplant — фиксируем наш вклад в задержку."""
        self.awaiting_first_frame = False
        if not self.reply_t0:
            return
        ttfb = int((time.time() - self.reply_t0) * 1000)
        self.serve_ms.append(ttfb)
        self.log(f"reply #{len(self.serve_ms)}: первый кадр в Voximplant через {ttfb} мс "
                 f"после первой дельты модели")

    # ------------------------------------------------------------------
    # Перебивание
    # ------------------------------------------------------------------
    def _is_speaking(self) -> bool:
        """Играет ли сейчас реплика ассистента (по оценке конца воспроизведения)."""
        return self.play_end_time > time.time()

    def _flush_output(self) -> int:
        """
        Выбрасываем всё несыгранное и возвращаем сколько миллисекунд сбросили.

        Модель генерирует заметно быстрее реального времени, поэтому к моменту
        перебивания в очереди могут лежать секунды уже готовой речи. Свою очередь
        гасим здесь, буфер Voximplant — сообщением barge_in сценарию.

        play_end_time обнуляем обязательно: после clearMediaBuffer в Voximplant
        пусто, а пейсинг-цикл продолжал бы считать, что запас на LEAD_LIMIT_MS уже
        отправлен, и придержал бы СЛЕДУЮЩУЮ реплику на эти полторы секунды — та же
        ловушка, что описана в handler_fish_tts («иначе следующая реплика простояла
        бы в throttle из-за уже сброшенного аудио»).
        """
        dropped = len(self.out_pending)
        self.out_pending.clear()
        while True:
            try:
                dropped += len(self.out_queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        self.play_end_time = 0.0
        self.mute_until = time.time() + BARGE_IN_MUTE_MS / 1000
        self.awaiting_first_frame = False
        self._close_reply()
        return (dropped // 2) * 1000 // LIVE_RATE

    async def _maybe_barge_in(self, delta: str):
        """
        Абонент заговорил поверх ассистента.

        Своего события «меня перебили» у GPT-Live нет, поэтому сигналом служит
        первый же фрагмент распознанной речи абонента: он приходит именно потому,
        что модель его услышала. Модель после этого замолкает сама — наша задача
        только убрать то, что она успела сгенерировать заранее.

        Cooldown обязателен. Одна фраза абонента разбирается на десятки фрагментов
        транскрипта, а модель full-duplex и нередко начинает отвечать ещё до того,
        как абонент договорил. Без задержки хвост той же самой фразы немедленно
        сбрасывал бы уже НОВУЮ реплику — и так по кругу, пока абонент не замолчит.
        """
        now = time.time()
        if now < self.barge_in_cooldown_until or not delta.strip() or not self._is_speaking():
            return
        # Ассистент уже договаривает: генерация кончилась (очередь пуста) и в
        # Voximplant остался короткий хвост. Рубить его — значит обрывать фразу на
        # полуслове из-за любого «ага». В виджете такой потери нет: там буфер
        # микроскопический, здесь — до LEAD_LIMIT_MS готовой речи.
        if (self.out_queue.empty() and not self.out_pending
                and (self.play_end_time - now) * 1000 < BARGE_IN_MIN_TAIL_MS):
            return
        self.barge_in_cooldown_until = now + BARGE_IN_COOLDOWN_MS / 1000
        dropped_ms = self._flush_output()
        self.barge_ins += 1
        self.barge_in_dropped_ms += dropped_ms
        await self.send_json({"type": "barge_in"})
        self.log(f"barge-in #{self.barge_ins} on \"{delta.strip()[:40]}\": dropped {dropped_ms} ms")

    # ------------------------------------------------------------------
    # Сервер → Voximplant: кадры по 20 мс с ограничением опережения
    # ------------------------------------------------------------------
    async def _send_stream_start(self):
        enc = self.vox_encoding if self.vox_encoding in ("ULAW", "ALAW") else PCM_ENCODING_BY_RATE.get(self.vox_rate, "PCM16")
        rate = 8000 if enc in ("ULAW", "ALAW", "PCM8") else self.vox_rate
        await self.send_json({
            "event": "start", "sequenceNumber": self.sequence,
            "start": {"mediaFormat": {"encoding": enc, "sampleRate": rate}},
        })
        self.sequence += 1
        self.stream_out_started = True
        self.log(f"StartEvent sent to Voximplant: {enc} @ {rate} Hz")

    async def _pump_out_audio(self):
        frame_bytes = int(LIVE_RATE * FRAME_MS / 1000) * 2
        # Буфер общий с _flush_output: иначе перебивание не достанет до кадров,
        # которые уже разобраны из очереди, но ещё не отправлены.
        pending = self.out_pending
        try:
            while not self.stop_event.is_set():
                try:
                    chunk = await asyncio.wait_for(self.out_queue.get(), timeout=0.25)
                except asyncio.TimeoutError:
                    continue
                pending.extend(chunk)
                while len(pending) >= frame_bytes and not self.ws_closed:
                    frame = bytes(pending[:frame_bytes]); del pending[:frame_bytes]
                    if not self.stream_out_started:
                        await self._send_stream_start()
                    # Пейсинг: не убегаем вперёд воспроизведения больше LEAD_LIMIT_MS
                    now = time.time()
                    lead_ms = (self.play_end_time - now) * 1000
                    if lead_ms > LEAD_LIMIT_MS:
                        await asyncio.sleep((lead_ms - LEAD_LIMIT_MS) / 1000)
                        now = time.time()
                    self.play_end_time = max(self.play_end_time, now) + FRAME_MS / 1000
                    if self.awaiting_first_frame:
                        self._note_first_frame()
                    await self.send_json({
                        "event": "media", "sequenceNumber": self.sequence,
                        "media": {"timestamp": self.samples_sent, "chunk": self.chunk,
                                  "payload": base64.b64encode(self._from_live_pcm(frame)).decode("ascii")},
                    })
                    self.sequence += 1; self.chunk += 1; self.frames_sent += 1
                    self.samples_sent += len(frame) // 2
        except Exception as e:
            self.log(f"audio pump error: {e}", "error")

    # ------------------------------------------------------------------
    async def _finish(self):
        closed = None
        if self.live is not None:
            try:
                closed = await self.live.close()
            except Exception as e:
                self.log(f"live close error: {e}", "warning")
            if closed and isinstance(closed.get("usage"), dict):
                self.usage_seconds = closed["usage"].get("seconds", self.usage_seconds)

        self._close_reply()
        turns = self.transcript.turns()
        base_ts = int(self.started_at * 1000)
        dialog = [{"role": t["role"], "text": t["text"], "ts": base_ts + int(t.get("start_ms") or 0)} for t in turns]
        elapsed = int(time.time() - self.started_at)
        self.log(f"finished: turns={len(dialog)} frames_sent={self.frames_sent} usage={self.usage_seconds}s elapsed={elapsed}s")

        summary = {"type": "call_summary", "dialog": dialog, "usage_seconds": self.usage_seconds,
                   "session_id": self.live.session_id if self.live else None,
                   "functions": (self.live.function_log if self.live else [])[-20:],
                   "barge_ins": self.barge_ins, "barge_in_dropped_ms": self.barge_in_dropped_ms,
                   "serve_ms": self.serve_ms[-40:], "serve_ms_median": _median(self.serve_ms),
                   "gen_speed_x10": self.gen_speed_x10[-40:],
                   "gen_speed_x10_median": _median(self.gen_speed_x10),
                   "model_ms": self.model_ms[-40:], "model_ms_median": _median(self.model_ms),
                   "speech_end_epoch": self.speech_end_epoch[-40:]}
        self.summary_sent = await self.send_json(summary)
        if not self.summary_sent and dialog:
            # Сценарий уже ушёл — сохраняем сами, чтобы диалог не пропал
            pairs = self.transcript.pairs()
            asyncio.create_task(_save_dialog_fallback(
                str(self.assistant.id), self.chat_id or self.call_id, pairs, self.caller_number, self.call_id,
                self.usage_seconds if self.usage_seconds is not None else elapsed,
            ))


async def _save_dialog_fallback(assistant_id, session_id, pairs, caller_number, call_id, duration):
    db = SessionLocal()
    try:
        for p in pairs:
            ConversationService.save_conversation(
                db=db, assistant_id=assistant_id,
                user_message=p["user"] or "", assistant_message=p["assistant"] or "",
                session_id=session_id, caller_number=f"INBOUND: {caller_number}",
                client_info={"transport": "gpt-live-1", "channel": "telephony", "call_id": call_id, "fallback": True},
                audio_duration=float(duration) if duration is not None else None, tokens_used=0,
            )
        logger.info(f"[LIVE-TEL] fallback: saved {len(pairs)} dialog record(s) for call {call_id}")
    except Exception as e:
        logger.error(f"[LIVE-TEL] fallback save failed: {e}", exc_info=True)
    finally:
        db.close()


async def handle_live_telephony(websocket: WebSocket, assistant_id: str, db: Session):
    await LiveTelephonyBridge(websocket, assistant_id, db).start()
