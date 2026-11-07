# BardForge Foundry

**Экспериментальная интеграция. Не готова для обычной игровой сессии.** В Studio пока нет подключённой панели отправителя. Работа в настоящем мире Foundry с удалённым игроком, публичным TLS и TURN **NOT VERIFIED**. Установка ZIP не превращает Core в готовый источник трансляции.

Это основной репозиторий официальной Foundry-интеграции: приёмник для Foundry VTT, транспортный SDK отправителя и отдельный сервер соединений. [BardForge Studio](https://github.com/BardForge/bardforge) — самостоятельный локальный микшер, который работает без этого дополнения.

## С чего начать

| Кому                          | Руководство                                                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Игроку                        | Готового подключения в Studio пока нет. В экспериментальном мире, подготовленном администратором, каждый игрок включает звук и регулирует личную громкость |
| Администратору тестового мира | [Установка, relay, ключи, сеть и диагностика](https://github.com/BardForge/bardforge-foundry/blob/dev/docs/administration.md)                              |
| Разработчику интеграции       | [Сборка, проверки и контракт SDK](https://github.com/BardForge/bardforge-foundry/blob/dev/docs/development.md)                                             |

Модуль рассчитан на API Foundry 13+, без неподтверждённой отметки `verified`. [Задача проверки удалённого игрока](https://github.com/BardForge/bardforge-foundry/issues/3) остаётся открытой. Публичных готовых релизов дополнения нет.

## Состав

- `modules/foundry/bardforge-receiver/` — приёмник с RU/EN и личной громкостью.
- `services/relay/` — авторизация и передача сигнализации; не передаёт и не хранит аудио.
- `sdk/` — браузерный отправитель, которому хост предоставляет настоящий `MediaStream`.
- `tests/` — протокол и передача синтезированного звука между браузерными контекстами.
- `scripts/package-module.ps1` — ZIP из разрешённого состава, включая LICENSE и уведомления.

Этот транспортный SDK не является общим Plugin SDK всей платформы. Исторические копии в Core сохранены для совместимости тестов; независимая разработка второй версии там не ведётся. Исправления сначала направляются сюда через PR в `dev`, затем при необходимости переносятся в Core с указанием исходного изменения.

## Происхождение, лицензия и участие

Код выделен из [Studio, commit 657771b](https://github.com/BardForge/bardforge/commit/657771b53093c5d33d16eb63e71b21bb87113d05). История и авторские уведомления исходного проекта не переименовываются и не присваиваются заново.

Собственный код — [MIT](LICENSE), с сохранением авторских уведомлений. [Сторонние компоненты](THIRD_PARTY.md) и [границы лицензии](LICENSING.md) описаны отдельно; Foundry VTT и бренд BardForge не лицензируются этим LICENSE. Основное приложение бесплатно; MIT допускает бесплатные и коммерческие интеграции.

[Участие](https://github.com/BardForge/.github/blob/dev/CONTRIBUTING.md) · [безопасность](https://github.com/BardForge/.github/blob/dev/SECURITY.md) · [CHANGELOG](CHANGELOG.md) · [общая доска](https://github.com/orgs/BardForge/projects/1).

## AI-Assisted Development

BardForge is developed with assistance from artificial intelligence tools. AI may contribute to code, documentation, testing, and technical design. All contributions remain subject to human review, validation, and applicable licensing requirements.
