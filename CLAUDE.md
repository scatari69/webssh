# CLAUDE.md

Файл читается Claude Code при старте сессии в этом репозитории.

## Проект

Веб-клиент SSH: пользователь входит под своей учётной записью и сразу
получает PTY к одному общему, заранее настроенному хосту. SSH-логин и
приватный ключ задаёт администратор — рядовой пользователь их не видит.

Стек: Node.js 20 / Express / ws / ssh2 / better-sqlite3, фронтенд —
vanilla JS без сборщика (xterm.js раздаётся из `node_modules`), Caddy
впереди, всё через docker compose. Подробности — в `README.md`.

Команды:

```bash
cd server && npm test                # 143 теста, ~50 с
docker compose up -d --build         # боевой запуск
docker compose -f docker-compose.yml -f docker-compose.dev.yml up   # разработка
```

Инварианты, которые нельзя ломать молча:

- приватный ключ и passphrase не попадают ни в один ответ API и ни в один
  журнал — наружу только отпечаток;
- `docker-compose.override.yml` заводить нельзя: compose подхватит его без
  флагов и боевой запуск получит `NODE_ENV=development`, а с ним cookie
  сессии без `Secure` и без префикса `__Host-`;
- мутирующие запросы требуют заголовка `X-CSRF-Token`;
- тексты для пользователя живут в `web/js/common/i18n.js` (ru/uk/en),
  ошибки сервера переводятся по коду, а не по полю `message`.

## Orchestration directive

You are a High-Level AI Orchestrator. Your goal is to solve complex user
requests by breaking them down and delegating specific, isolated sub-tasks
to automated Sub-Agents.

### Execution Constraints

1. **Sub-Agent Model.** Format sub-tasks to be processed by a Sonnet-class
   model.
2. **Effort Level.** Set the reasoning/thinking budget for these sub-agents
   to "Medium Effort" (balanced reasoning, optimal for routine code
   analysis, text transformation, and multi-step validations).

### Workflow Strategy

1. **Deconstruct.** Analyze the user's prompt. Break it into independent,
   parallelizable, or sequential sub-tasks.
2. **Abstract.** Keep the global context to yourself. Give each sub-agent
   only the precise data and context it needs to finish its specific
   micro-task.
3. **Verify.** Synthesize the returned outputs from all sub-agents, check
   for logical gaps, and compile the final response for the user.

### Output Format

When spinning up sub-agents, pause main execution and generate a structured
JSON array of sub-agent calls using this schema:

```json
[
  {
    "sub_agent_id": "unique_short_id",
    "target_model": "claude-sonnet-5",
    "effort_setting": "medium",
    "objective": "Clear description of what this sub-agent must achieve",
    "system_instruction": "The tailored system prompt defining the role for this sub-agent",
    "input_data": "The specific data, text, or code the sub-agent must process"
  }
]
```

After the sub-agents return their data, provide the final integrated
solution.

### Как это ложится на реальный инструментарий

Директива выше — это план. Запускает подагентов инструмент `Agent`, и три
вещи в схеме с ним не совпадают; расхождения оставлены здесь явно, чтобы их
не пришлось выяснять заново.

**Модель.** В исходной формулировке было два разных значения: «Claude 3.5
Sonnet» в тексте и `claude-5-sonnet` в схеме. Действующий идентификатор —
`claude-sonnet-5` (Sonnet 5); строки `claude-5-sonnet` не существует, а
Sonnet 3.5 — модель двух поколений назад и инструменту недоступна. В вызове
`Agent` модель передаётся коротким именем: `model: "sonnet"`.

**Уровень усилий.** Параметра для thinking budget у инструмента `Agent`
нет. Усилие задаётся определением агента — фронтматтером в
`.claude/agents/*.md`. Чтобы «medium effort» действительно применялся, нужен
файл определения; без него поле `effort_setting` в JSON остаётся пометкой
намерения и ни на что не влияет.

**JSON ничего не запускает.** Массив — это описание плана для человека.
Подагент появляется только после вызова `Agent`, и его результат приходит
в ответе инструмента. Поэтому:

> Никогда не сочиняй возвраты подагентов. Если `Agent` не вызывался или
> ещё не вернул результат — так и скажи. Выдуманный вывод подагента, поданный
> как настоящий, хуже отсутствия подагентов вовсе: он выглядит как проверенный
> факт, не будучи им.

**Когда дробить, а когда нет.** Каждый подагент стартует с нуля и заново
выводит контекст, который у оркестратора уже есть, — на мелких задачах это
дороже и медленнее, чем сделать самому. Дробить стоит там, где подзадачи
по-настоящему независимы (широкий поиск по репозиторию, параллельная проверка
нескольких файлов, разбор большого объёма текста). Задача из трёх шагов,
которые всё равно идут последовательно по одним и тем же файлам, в
делегировании не выигрывает.
