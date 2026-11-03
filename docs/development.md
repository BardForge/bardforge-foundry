# Руководство разработчика

[BardForge Foundry](../README.md) → Разработка

Это основной репозиторий приёмника, relay и транспортного SDK. Исправления сначала проходят PR в его `dev`, затем при необходимости переносятся в совместимые копии Core с указанием исходного commit/PR. Общий Plugin SDK платформы — отдельное будущее направление.

## Зависимости и проверки

Нужен **Node.js 24**. Версии Playwright и `ws` взяты из lock-файлов исходного проекта; зависимости ядра Studio не требуются.

```powershell
npm ci
npm ci --prefix services/relay
npx playwright install chromium
npm run lint
npm run format:check
npm run check:public
npm test
npm run test:browser
```

`npm test` проверяет авторизацию и разделение ролей, маршрутизацию, лимиты, таймауты и изоляцию сбоя одного слушателя, а также комплектность модуля. `npm run test:browser` запускает один Chromium с двумя изолированными контекстами, создаёт тон в Web Audio и проверяет Opus RTP, ненулевую декодированную волну, личную громкость, восстановление после перезапуска relay и прекращение звука после остановки отправителя. Реальный микрофон и пользовательские аудиофайлы не нужны.

Браузерный тест не запускает Foundry и не меняет мир пользователя. Случайные ключи существуют только во время теста. Для ручной проверки сервера отдельно достаточно `npm ci --prefix services/relay`; Playwright нужен только для тестов.

CI выполняет эти же проверки на Windows с Node 24, затем собирает ZIP. GitHub Actions закреплены по SHA; у workflow только `contents: read`. Публикации релизов, деплоя, подписи и установки в пользовательский Foundry нет.

`npm run format` применяет форматирование. `check:public` проверяет отслеживаемые и ещё не добавленные публичные файлы, исключённые через `.gitignore` результаты сборки и зависимости в проверку не входят. Это проверка запрещённых путей и известных форматов секретов, а не универсальный поиск любых конфиденциальных данных. Перед публикацией также нужен просмотр diff. Лицензии зависимостей описаны в [THIRD_PARTY.md](../THIRD_PARTY.md), изменения — в [CHANGELOG.md](../CHANGELOG.md).

## SDK отправителя

SDK предназначен для браузера в безопасном контексте. Хост должен предоставить живой аудио-`MediaStream`, например выход `AudioContext.createMediaStreamDestination()`. Разрешение воспроизведения, интерфейс, маршрутизация выбранных дорожек и хранение настроек остаются ответственностью интеграции.

```js
import { RelayAudioClient } from './sdk/index.js';

const publisher = new RelayAudioClient({
  role: 'publisher',
  url: relayUrl,
  room: roomName,
  token: publisherKey,
  stream: audioStream,
  iceServers: configuredIceServers,
  onState: ({ state, listeners }) => renderConnectionState(state, listeners),
});
publisher.start();
// При завершении сессии:
publisher.stop();
```

Переменные в примере предоставляет хост; это контракт интеграции, а не готовое приложение. `stop()` закрывает соединения, но не останавливает дорожки, принадлежащие микшеру. Тестовый отправитель с реальным тоном уже есть в `tests/transport.browser.mjs`.

## Безопасность и происхождение

Исторический исходник выделен из [Studio, commit 657771b](https://github.com/ShinozakiAichi/BardForge-Studio/commit/657771b53093c5d33d16eb63e71b21bb87113d05). React-панель не является самостоятельным отправителем и не включена сюда. Собственный код — [MIT](../LICENSE), зависимости — по своим лицензиям; см. [THIRD_PARTY](../THIRD_PARTY.md).

WebRTC передаёт зашифрованное аудио напрямую или через TURN; relay пересылает только SDP/ICE, не хранит аудио. На каждого слушателя создаётся соединение, по умолчанию разрешены один отправитель и 16 слушателей. Нет SFU, аудиозаписи и панели нескольких комнат. Ключи, пользовательские записи и приватные логи не входят в код/ZIP.

Основа интеграции: [разработка модулей Foundry](https://foundryvtt.com/article/module-development/), [API Foundry 13](https://foundryvtt.com/api/v13/classes/foundry.helpers.ClientSettings.html), [WebRTC](https://www.w3.org/TR/webrtc/), [TURN](https://webrtc.org/getting-started/turn-server).
