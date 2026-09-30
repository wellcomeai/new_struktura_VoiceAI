/*
 * Прогон test_outbound-calls.html в Chromium с подставным API:
 * ассистенты всех провайдеров одним списком, выбор номера/ассистента,
 * запуск обзвона уходит в /api/telephony/start-outbound-call с прежним телом.
 *
 *   node backend/static/test_outbound_calls_page.js   (нужен playwright)
 */
const path = require("path");
function loadPlaywright() {
    for (const c of ["playwright", path.join(__dirname, "node_modules", "playwright"),
                     path.join(__dirname, "..", "..", "node_modules", "playwright")]) {
        try { return require(c); } catch (e) { /* следующий */ }
    }
    console.error("playwright не найден. Установите: npm i playwright");
    process.exit(1);
}
const { chromium } = loadPlaywright();
const STATIC = __dirname;

const FISH = { id: "af3cdd96-1834-4123-9554-b3057075c399", name: "Спа центр", created_at: "2026-09-20T10:00:00" };
const CASCADE = { id: "11111111-2222-3333-4444-555555555555", name: "Каскад продажи", created_at: "2026-09-25T10:00:00" };
const OPENAI = { id: "66666666-7777-8888-9999-000000000000", name: "Старый OpenAI", created_at: "2025-01-01T10:00:00" };
const NUMBER = { id: "99999999-8888-7777-6666-555555555555", phone_number: "+79311071031", phone_region: "Санкт-Петербург" };

let posted = null;
function apiBody(p, method, body) {
    if (p === "/api/telephony/start-outbound-call" && method === "POST") {
        posted = JSON.parse(body);
        return { success: true, message: "Запущено 1 из 2", total_requested: 2, started: 1, failed: 1,
                 results: [{ phone: posted.target_phones[0], status: "started", session_id: "123" },
                           { phone: posted.target_phones[1], status: "failed", error: "Недостаточно средств" }] };
    }
    if (p.startsWith("/api/fish-assistants")) return { assistants: [FISH] };
    if (p.startsWith("/api/grok-assistants/cascade")) return [CASCADE];
    if (p === "/api/assistants/") return [OPENAI];
    if (p.startsWith("/api/gemini-assistants") || p.startsWith("/api/cartesia-assistants")) return [];
    if (p.startsWith("/api/yandex-assistants")) return { assistants: [] };
    if (p.startsWith("/api/telephony/my-numbers")) return { numbers: [NUMBER], total: 1 };
    if (p.startsWith("/api/users/me")) return { id: "u1", email: "t@t.ru", onboarding_completed: true, subscription_active: true };
    if (p.startsWith("/api/wallet/tariffs/me")) return { tariffs: [{ code: "fish", name: "Fish Audio" }, { code: "cascade", name: "Каскад" }] };
    return {};
}

function check(cond, msg, errors) {
    if (!cond) {
        console.error("❌ " + msg);
        (errors || []).forEach((e) => console.error("   " + e));
        process.exit(1);
    }
}

(async () => {
    const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
    for (const width of [1280, 390]) {
        posted = null;
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
        await page.route("**/*", async (route) => {
            const req = route.request();
            const p = new URL(req.url()).pathname;
            if (p.startsWith("/api/")) {
                return route.fulfill({ status: 200, contentType: "application/json",
                                       body: JSON.stringify(apiBody(p, req.method(), req.postData())) });
            }
            if (p.startsWith("/static/")) {
                try { return await route.fulfill({ path: path.join(STATIC, p.replace("/static/", "")) }); }
                catch { return route.fulfill({ status: 404, body: "" }); }
            }
            return route.fulfill({ status: 200, contentType: "text/css", body: "" });
        });
        await page.addInitScript(() => localStorage.setItem("auth_token", "fake-jwt"));
        await page.goto("https://voicyfy.ru/static/test_outbound-calls.html", { waitUntil: "networkidle" });
        await page.waitForTimeout(500);

        check(await page.locator(".vf-sidebar .sidebar-nav-item.active", { hasText: "Телефония" }).count() === 1,
              "в сайдбаре не подсвечена «Телефония»", errors);
        const caller = await page.textContent("#caller-select");
        check(caller.indexOf("+7 (931) 107-10-31") !== -1, "единственный номер не выбран: " + caller, errors);

        await page.click("#assistant-select .vf-select-btn");
        const items = await page.$$eval(".vf-menu.open .vf-menu-item", (els) => els.map((e) => e.textContent.trim()));
        const groups = await page.$$eval(".vf-menu.open .vf-menu-group", (els) => els.map((e) => e.textContent.trim()));
        check(items.some((t) => t.indexOf(FISH.name) !== -1) && items.some((t) => t.indexOf(CASCADE.name) !== -1) &&
              items.some((t) => t.indexOf(OPENAI.name) !== -1), "не все ассистенты в списке: " + items.join(" | "), errors);
        check(groups.join(",") === "Fish Audio,Каскад,OpenAI", "группы провайдеров: " + groups.join(","), errors);
        await page.click(".vf-menu.open .vf-menu-item:has-text('" + FISH.name + "')");

        check(await page.isDisabled("#start-button"), "кнопка активна без номеров", errors);
        await page.fill("#target-phones", "89161234567\n+7 (916) 234-56-78\nмусор");
        await page.fill("#call-task", "Напомнить о записи");
        check(!(await page.isDisabled("#start-button")), "кнопка не активировалась", errors);
        check((await page.textContent("#phones-count")) === "2", "счётчик номеров неверен", errors);
        await page.click("#start-button");
        await page.waitForTimeout(400);

        check(posted && posted.assistant_type === "fish" && posted.assistant_id === FISH.id &&
              posted.phone_number_id === NUMBER.id && posted.mute_duration_ms === 3000 &&
              posted.task === "Напомнить о записи" &&
              JSON.stringify(posted.target_phones) === JSON.stringify(["+79161234567", "+79162345678"]),
              "тело запуска неверно: " + JSON.stringify(posted), errors);
        const log = await page.textContent("#results-log");
        check((await page.textContent("#started-count")) === "1" && (await page.textContent("#failed-count")) === "1" &&
              log.indexOf("Недостаточно средств") !== -1, "результаты не отрисованы: " + log, errors);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        check(overflow <= 0, "горизонтальная прокрутка на ширине " + width + ": " + overflow + "px", errors);
        check(errors.length === 0, "ошибки JS:", errors);
        await page.screenshot({ path: process.env.SHOT_DIR ? path.join(process.env.SHOT_DIR, "outbound-" + width + ".png") : "/dev/null", fullPage: true });
        console.log("✅ ширина " + width + ": список ассистентов всех провайдеров, запуск с прежним телом, результаты");
        await page.close();
    }
    await browser.close();
    console.log("\nстраница исходящих звонков проверена");
})();
