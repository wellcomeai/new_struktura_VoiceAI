"""
Тестовый скрипт для диагностики проблемы с исходящими звонками
"""
import asyncio
import httpx
import json

# Тестовые данные
TEST_DATA = {
    "account_id": "12345678",
    "api_key": "test_api_key_12345",
    "rule_id": "123456",
    "script_custom_data": json.dumps({
        "phone_number": "+79001234567",
        "assistant_id": "test-assistant-id",
        "caller_id": "+1234567890"
    })
}

async def test_endpoint():
    """Тестируем эндпоинт напрямую"""
    print("="*70)
    print("🧪 ТЕСТ ЭНДПОИНТА /api/voximplant/start-outbound-call")
    print("="*70)
    
    # URL для тестирования
    BASE_URL = "https://voicyfy.ru"  # Или http://localhost:5050 для локального теста
    ENDPOINT = f"{BASE_URL}/api/voximplant/start-outbound-call"
    
    print(f"\n📍 URL: {ENDPOINT}")
    print(f"\n📦 Тестовые данные:")
    print(json.dumps(TEST_DATA, indent=2, ensure_ascii=False))
    
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            print("\n🚀 Отправляем POST запрос...")
            
            # Пробуем разные способы отправки
            
            # Способ 1: JSON
            print("\n--- Попытка 1: Content-Type: application/json ---")
            try:
                response1 = await client.post(
                    ENDPOINT,
                    json=TEST_DATA,
                    headers={"Content-Type": "application/json"}
                )
                print(f"✅ Статус: {response1.status_code}")
                print(f"📄 Ответ: {response1.text}")
            except Exception as e:
                print(f"❌ Ошибка: {e}")
            
            # Способ 2: data (form-encoded)
            print("\n--- Попытка 2: Content-Type: application/x-www-form-urlencoded ---")
            try:
                response2 = await client.post(
                    ENDPOINT,
                    data=TEST_DATA
                )
                print(f"✅ Статус: {response2.status_code}")
                print(f"📄 Ответ: {response2.text}")
            except Exception as e:
                print(f"❌ Ошибка: {e}")
            
            # Способ 3: Прямой JSON в content
            print("\n--- Попытка 3: Прямой JSON в content ---")
            try:
                response3 = await client.post(
                    ENDPOINT,
                    content=json.dumps(TEST_DATA),
                    headers={"Content-Type": "application/json"}
                )
                print(f"✅ Статус: {response3.status_code}")
                print(f"📄 Ответ: {response3.text}")
            except Exception as e:
                print(f"❌ Ошибка: {e}")
                
    except Exception as e:
        print(f"\n❌ Общая ошибка: {e}")

async def check_routes():
    """Проверяем зарегистрированные маршруты"""
    print("\n"+"="*70)
    print("🔍 ПРОВЕРКА ЗАРЕГИСТРИРОВАННЫХ МАРШРУТОВ")
    print("="*70)
    
    try:
        # Импортируем приложение
        from app import app
        
        print("\n📋 Все маршруты в приложении:")
        
        voximplant_routes = []
        
        for route in app.routes:
            if hasattr(route, 'path') and hasattr(route, 'methods'):
                # Ищем наш эндпоинт
                if '/voximplant/' in route.path:
                    voximplant_routes.append({
                        'path': route.path,
                        'methods': list(route.methods),
                        'name': route.name
                    })
        
        if voximplant_routes:
            print("\n✅ Найдены Voximplant маршруты:")
            for route in voximplant_routes:
                print(f"   {route['methods']} {route['path']} (name: {route['name']})")
                
            # Проверяем наш конкретный эндпоинт
            our_endpoint = [r for r in voximplant_routes if 'start-outbound-call' in r['path']]
            
            if our_endpoint:
                print(f"\n✅ Эндпоинт /api/voximplant/start-outbound-call НАЙДЕН!")
                print(f"   Методы: {our_endpoint[0]['methods']}")
            else:
                print(f"\n❌ Эндпоинт /api/voximplant/start-outbound-call НЕ НАЙДЕН!")
        else:
            print("\n❌ Voximplant маршруты не найдены!")
            
    except Exception as e:
        print(f"\n❌ Ошибка проверки маршрутов: {e}")
        import traceback
        traceback.print_exc()

async def check_function_signature():
    """Проверяем сигнатуру функции"""
    print("\n"+"="*70)
    print("🔬 ПРОВЕРКА СИГНАТУРЫ ФУНКЦИИ")
    print("="*70)
    
    try:
        from backend.api import voximplant
        import inspect
        
        # Получаем функцию
        func = voximplant.start_outbound_call
        
        print("\n📝 Сигнатура функции start_outbound_call:")
        print(f"   {inspect.signature(func)}")
        
        # Получаем параметры
        params = inspect.signature(func).parameters
        
        print("\n📋 Параметры функции:")
        for param_name, param in params.items():
            print(f"   - {param_name}: {param.annotation}")
            print(f"     default: {param.default}")
            
    except Exception as e:
        print(f"\n❌ Ошибка: {e}")
        import traceback
        traceback.print_exc()

async def main():
    """Главная функция"""
    print("\n" + "🔧"*35)
    print("ДИАГНОСТИКА ЭНДПОИНТА ИСХОДЯЩИХ ЗВОНКОВ")
    print("🔧"*35 + "\n")
    
    # Шаг 1: Проверяем маршруты
    await check_routes()
    
    # Шаг 2: Проверяем сигнатуру функции
    await check_function_signature()
    
    # Шаг 3: Тестируем эндпоинт
    await test_endpoint()
    
    print("\n" + "✅"*35)
    print("ДИАГНОСТИКА ЗАВЕРШЕНА")
    print("✅"*35 + "\n")

if __name__ == "__main__":
    asyncio.run(main())
