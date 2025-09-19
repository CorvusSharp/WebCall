# Архитектура WebCall (обновлённая под SOLID)

## Цели рефакторинга
- Устранить смешение слоёв (бизнес-логика / транспорт / инфраструктура).
- Ввести интерфейсы для зависимостей (DIP + ISP).
- Изолировать ответственность (SRP) для звонков и push-уведомлений.

## Слоёвое разделение
```
core/
  domain/        – модели домена (entities / values)
  ports/         – абстрактные интерфейсы (repositories, services)
application/
  use_cases/     – сценарии (оркестрация доменных операций)
infrastructure/
  db/            – реализации репозиториев
  services/      – адаптеры (push, call invites, webpush)
  security/      – JWT, password hashing
presentation/
  api/           – FastAPI роуты (только HTTP контракт + DI)
  ws/            – WebSocket обработчики (тонкие)
  static/        – фронтенд
```

## Новые интерфейсы
### `PushNotifier`
```
async def notify_incoming_call(to_user_id, from_user_id, from_username, room_id) -> None
```
Инкапсулирует способ доставки push (WebPush сейчас, можно добавить e-mail/SMS).

### `CallInviteService`
```
invite(from, to, room_id, from_username, from_email)
accept(from, to, room_id)
decline(from, to, room_id)
cancel(from, to, room_id)
list_pending_for(user_id) -> list[dict]
```
Хранение и публикация событий звонка; фронт получает события через friends WebSocket.

## Реализации
- `infrastructure/services/push_notifier.py` – `SimplePushNotifier`
- `infrastructure/services/call_invites.py` – `InMemoryCallInviteService`

## DI контейнер
`presentation/api/deps/containers.py` расширен провайдерами:
- `get_call_invite_service()` – singleton in-memory
- `get_push_notifier()` – singleton push + зависимости репозиториев

## Принятые решения
- Существующие функции `publish_call_*` сохранены для обратной совместимости; вызываются сервисом.
- Перенос хранения `_pending_calls` начат: WebSocket больше не обращается напрямую, но legacy dict пока обновляется publish-функциями (мягкая миграция).

## Что ещё планируется
1. Декомпозиция фронтенда (`main.js`) на:
   - `devices.js` – управление устройствами
   - `calls.js` – эфемерные звонки
   - `webrtc-manager.js` – RTC уровень (уже частично есть `webrtc.js`)
   - `direct_chat.js` – личные сообщения + E2EE
   - `notifications.js` – push + разрешения
2. Redis реализация `CallInviteService` (устойчивость + TTL автоочистка).
3. Выделение менеджера WebSocket друзей:
   - `FriendsChannelManager` (отдельный класс вместо глобальных структур)
4. Доменные события (event bus) для унификации публикации:
   - События: `CallInvited`, `CallAccepted`, `CallDeclined`, `CallCancelled`.
5. Unit-тесты на сервисы (пример шаблона ниже).

## Пример теста (набросок)
```python
import pytest
from uuid import uuid4
from app.infrastructure.services.call_invites import InMemoryCallInviteService

@pytest.mark.asyncio
async def test_invite_and_list():
    svc = InMemoryCallInviteService()
    a, b = uuid4(), uuid4()
    await svc.invite(a, b, 'room-x', 'alice', 'alice@example.com')
    pend_b = await svc.list_pending_for(b)
    assert any(p['roomId'] == 'room-x' for p in pend_b)
    await svc.cancel(a, b, 'room-x')
    pend_b2 = await svc.list_pending_for(b)
    assert not pend_b2
```

## Принципы SOLID после рефакторинга
| Принцип | Статус | Комментарий |
|---------|--------|-------------|
| SRP | Улучшен | Сервисы выделены; фронт монолитный (в работе). |
| OCP | Улучшен | Новые реализации push / call storage добавляются без правок роутов. |
| LSP | OK | Контракты просты и соблюдаемы. |
| ISP | Улучшен | Узкие интерфейсы вместо неявных модульных зависимостей. |
| DIP | Существенно лучше | Роуты зависят от абстракций. |

## Риски и технический долг
- In-memory хранение инвайтов → потеря состояния при рестарте.
- Отсутствие тайм-аута автоочистки (предлагается TTL в Redis варианте).
- Ограниченное логирование (нет кореляции запросов/событий).

## Следующие итерации (приоритет)
1. Redis `CallInviteService` + TTL.
2. Декомпозиция фронтенда. (Выполнено: см. раздел "Фронтенд архитектура" ниже)
3. Unit-тесты сервисов.
4. Event Bus.
5. Метрики.

---
Последнее обновление: см. git историю текущего коммита.

## Фронтенд архитектура (после декомпозиции)

До рефакторинга логика была сосредоточена в одном крупном файле `static/js/main.js` (~1800 строк), что усложняло понимание, тестирование и эволюцию. Теперь применён модульный подход: `main.js` стал тонким фасадом, а функциональные области вынесены в независимые ES-модули с явными зависимостями.

### Структура модулей
```
static/js/
  main.js                – фасад: auth guard + запуск `appInit` + обработка события join-room
  modules/
    core/
      state.js           – централизованное runtime-состояние (ws, rtc, выбор устройств, активный звонок, карты unread и т.д.)
      dom.js             – ссылки на DOM-элементы + простые утилиты UI (setText, appendLog, appendChat)
    calls.js             – состояние эфемерного звонка (invite/accept/decline/cancel), спец-рингтон, переходы состояний
    visited_rooms.js     – загрузка/рендер истории комнат, диспатч кастомного события `wc:join-room`
    e2ee.js              – ECDH (P-256) + AES-GCM шифрование/дешифрование личных сообщений, хранение ключей (IndexedDB + fallback)
    direct_chat.js       – выбор друга, загрузка и потоковое обновление личных сообщений, unread счетчики, read-ack
    permissions.js       – запрашивание прав (микрофон, уведомления) + баннер рекомендаций
    push_subscribe.js    – инициализация push: регистрация SW, подписка, отправка subscription на сервер
    friends_ui.js        – рендер списков друзей и заявок, кнопки звонков/чата/удаления, дебаунс перезагрузок
    app_init.js          – оркестратор: инициализация UI, подключение к комнате (WS + WebRTC), friends WebSocket, вызовы init-модулей
```

### Ответственность и зависимости
| Модуль | Зависящие | Зависимости | Кратко |
|--------|-----------|-------------|--------|
| state  | все       | –           | Общий mutable state, точка обмена между модулями |
| dom    | все       | –           | Централизует поиск DOM, упрощает тестирование и замену |
| calls  | friends_ui, app_init | state, dom | Управляет жизненным циклом звонка и спец-рингтоном |
| visited_rooms | main (через событие) | dom | История комнат без знания о connectRoom |
| e2ee   | direct_chat | state (косвенно через локальные функции), Web Crypto | Ключи и криптооперации |
| direct_chat | friends_ui, app_init | e2ee, dom, state | Рендер и приём/отправка прямых сообщений |
| permissions | app_init | dom | Унифицированный UX управления правами |
| push_subscribe | app_init | – | Подписка на WebPush (VAPID) |
| friends_ui | app_init | calls, direct_chat, dom, state | Отрисовка списка друзей, кнопок, состояния звонков |
| app_init | main | все вышеперечисленные | Сборка: события UI, WS комнаты, WS друзей, последовательность init |
| main | – | app_init | Тонкий фасад, точка входа |

### Потоки событий
1. История комнат: кнопка "Войти" → dispatch `wc:join-room` → `main.js` → `connectRoom()` (в `app_init`).
2. Приглашение звонка: событие `call_invite` из WS друзей → `friends_ui` → `calls.setActiveIncomingCall()` + (условно) `startSpecialRingtone()`.
3. Принятие/отклонение: действия пользователя → вызовы `acceptCall / declineCall / cancelCall` (API) → события `call_accept / call_decline / call_cancel` → `friends_ui` / `calls` корректируют состояние и рингтон.
4. Личные сообщения: входящее `direct_message` → `direct_chat.handleIncomingDirect()` → UI + (при необходимости) Notification → E2EE дешифрование.
5. Push: `initPush()` регистрирует SW; SW сообщение `openDirect` → `app_init` слушатель → открытие нужного чата.

### Принципы
* SRP: каждый модуль решает одну область (звонки, чат, ключи, история, права).
* DIP: `app_init` зависит от интерфейсов (функций) модулей, а не от их внутреннего устройства.
* Расширяемость: добавление, например, `recording.js` или `presence_badges.js` – без правок существующих модулей, если они используют публичные функции.

### Переход с legacy
* Старый `main.js` полностью заменён фасадом. Если legacy код ожидал глобальные функции, возможно добавление адаптеров:
```js
// Пример (добавить при реальной необходимости)
// window.wcConnect = () => import('./modules/app_init.js').then(m => m.connectRoom());
```
* Все прямые обращения к DOM/глобалам теперь централизованы в `dom.js` и `state.js`.

### Возможные улучшения
1. Ввести лёгкий event-bus на фронте (CustomEvent обёртка) для ещё меньшей связности.
2. Типизация (TypeScript или JSDoc typedef) для state и сообщений.
3. Автотесты модулей E2EE и calls в изолированной среде (Jest / Vitest).
4. Ленивая (динамическая) загрузка тяжёлых модулей (E2EE) по первому использованию.
 5. Централизованный сбор WebRTC метрик (bitrate, packet loss, rtt) и UI.

### Диагностика
* Ранее существующие функции диагностики аудио перенесены в `WebRTCManager` и вызываются через UI кнопку.
* Потенциально можно вынести метрики (bitrate, packet loss) в отдельный модуль `stats.js`.

### Реализовано дополнительно
#### Event Bus
Добавлен модуль `core/event_bus.js` предоставляющий `bus.emit/on/once/off/waitFor` поверх `window.dispatchEvent`. Используются имена без префикса при вызове (`bus.emit('join-room')`), внутренне нормализуются к `wc:*`. Это уменьшает прямые `addEventListener` в фасаде и упрощает подписки.

Текущие события:
* `join-room` – инициировано подключение к комнате из истории.
* `stats:sample` – периодическая агрегированная выборка метрик WebRTC.

#### WebRTC Stats
Модуль `modules/stats.js`:
* Циклически (по умолчанию 3–4 c) вызывает `pc.getStats()` для каждого peer.
* Считает входящий/исходящий аудио bitrate (bps), оценку потерь пакетов и RTT (при наличии `remote-inbound-rtp`).
* Кэширует предыдущие байты для диффа.
* Публикует событие `stats:sample` (массив per-peer структур) через bus.
* В `app_init` установлена подписка — логирует строки в блок `els.stats`.

Это отделяет агрегирование телеметрии от UI и создаёт точку расширения (отправка на backend, хранение истории, алерты).

---
