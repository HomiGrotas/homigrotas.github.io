---
layout: post
title: "Building AI Agents from Zero to Hero"
date: 2026-09-15
category: learning
tags: [AI, agents, ai-agents]
severity: n-a
excerpt: "Started from building AI agent from zero, and improved slowly to AI agent frameworks — ending with a Pydantic AI agent that sends a weekly Parasha message on WhatsApp"
---

# My Learning Journey: Building an AI Agent From Scratch

> Building my own agent with no framework, a 3B local model, and plenty of rabbit holes.

---

## The Beginning: Why I Started

I wanted to understand how AI agents actually work. Not just from tutorials that tell you to call `agent.run()` and call it a day — but the real mechanics: how a model decides to use a tool, how the conversation loop works, and what happens when you strip away all the framework magic.

The rule I set for myself was simple: **no agent frameworks.** I wrote every piece of the loop by hand. It was the only way I would actually learn.

## Phase 1: A Hand-Written Agent

My first version was a simple REPL loop:

```python
while True:
    user_input = input("User: ").strip()
    messages_context.append({"role": "user", "content": user_input})

    response = client.chat.completions.create(
        model=MODEL,
        tools=TOOLS_SCHEMA,
        messages=messages_context,
    )
    message = response.choices[0].message
    messages_context.append(message.model_dump(exclude_none=True))

    while message.tool_calls:
        for tool_call in message.tool_calls:
            messages_context.append(call_tool(tool_call))

        response = client.chat.completions.create(
            model=MODEL,
            tools=TOOLS_SCHEMA,
            messages=messages_context,
        )
        message = response.choices[0].message
        messages_context.append(message.model_dump(exclude_none=True))

    print(f"Dorina: {message.content}")
```

Nothing fancy. But walking through what happens on every turn taught me the core of multi-turn agents:

1. You send the whole conversation history plus a **system prompt**.
2. The model may respond with a plain answer *or* tool calls.
3. You execute the tools, feed the results back as `tool` messages, and let the model continue.
4. You repeat until the model is done — then you show the answer.

### What I learned about system prompts

I used Gemini to draft my system prompt, then edited it to fit. Key insight: **system prompts are the model's "operating manual"** — they set role, tone, and guardrails for the whole session. I keep mine in markdown (`system_prompt.md`), because structured text is much easier for a model to follow than a wall of prose.

One of my guardrails is memorable — *no hallucinations*:

> If you do not know the answer based on your training data or the provided context, state "I cannot verify this information locally" instead of guessing.

Spoiler: I learned later that prompt guardrails are one thing, and model capability is quite another.

### Why OpenAI's SDK with a local model?

Funny one. My model runs locally via **Ollama** (`llama3.2`, 3B parameters). But Ollama exposes an OpenAI-compatible API, so I could use the `openai` Python package against `http://localhost:11434/v1`. Zero extra dependencies — just a different `base_url`:

```python
client = OpenAI(
    base_url=os.environ.get("PROVIDER_URL", "http://localhost:11434/v1"),
    api_key=os.environ.get("OPENAI_API_KEY", "WE_DO_NOT_NEED_API_KEY_LOL"),
)
MODEL = os.environ.get("MODEL", "llama3.2")
```

### Adding tools

I gave the agent tools. I built two: `read_file` and `write_file`. Every tool needed an **OpenAI function schema** so the model knew when and how to call it:

```python
schema = {
    "type": "function",
    "function": {
        "name": "read_file",
        "description": "Read text content from a local file.",
        "parameters": { ... "required": ["path"] }
    }
}
```

The model never *runs* the tool — it only requests it. My code does the execution and returns the result into the conversation as a `tool` message:

```python
def call_tool(function_call):
    tool = ALL_TOOLS.get(function_call.function.name)
    if tool:
        argv = json.loads(function_call.function.arguments)
        result = tool.func(argv)
        return {
            "role": "tool",
            "tool_call_id": function_call.id,
            "name": tool.name,
            "content": result,
        }
    return f"Error: function {function_call.function.name} does not exist"
```

### Security from day one

A tool that touches the file system is an open door, so `read_file` confines paths to the working directory, caps the file size so it can't flood the context window, and returns errors *as data* the model can read instead of crashing:

```python
base_dir = Path.cwd().resolve()
target_path = (base_dir / raw_path).resolve()

if not target_path.is_relative_to(base_dir):
    return f"Error: Access denied. Path '{raw_path}' points outside working directory."

if target_path.stat().st_size > MAX_FILE_SIZE_BYTES:
    return f"Error: File '{raw_path}' is too large to read."
```

### Real-world failure: my agent "created" a file

Testing the agent, I asked it what was in a `license.txt` that didn't exist. Instead of admitting it, the model — a 3B local model — **called `write_file` to create an empty file, then confidently described a full license template it hallucinated**. When I called it out ("Are you sure? you created this file"), it doubled down.

That single interaction taught me more than any article:
- Small local models struggle hard with tool semantics and reasoning.
- Tool results look "trustworthy" to the model even when empty.
- A 3B model will confidently hallucinate rather than say "I don't know."
- Prompt guardrails *cannot* fix a fundamental capability gap.

## Phase 2: The Model Isn't Smart Enough

That was the turning point. The problem wasn't my code — it was the model. `llama3.2` (3B) just couldn't reason reliably enough for real tool use.

My first fix was pragmatic: a branch (`test/gemini`) where I ported the agent to the **Google AI SDK** with `gemini-3.6-flash`. It worked. The tool churn disappeared, and the agent finally "felt" smart.

```python
config = types.GenerateContentConfig(
    system_instruction=SYSTEM_PROMPT,
    tools=TOOLS_LIST,
    temperature=0.2,
)
chat = client.chats.create(model=MODEL, config=config)
response = chat.send_message(user_input)
```

A nice bonus: the Google SDK accepts plain Python functions as tools and runs the tool loop itself, so my hand-written schemas and `while message.tool_calls` loop simply disappeared:

```python
def read_file(path: str) -> str:
    ...

def write_file(path: str, content: str) -> str:
    ...

TOOLS_LIST = [read_file, write_file]
```

But it didn't take long to notice the trap: **using Google's SDK couples me to Gemini, period.** No swapping models, no choice. I'd traded one limitation for a different kind of lock-in.

## Phase 3: Building a Real Agent with Pydantic AI

After comparing **LangGraph** (expansive, feature-rich, built for complex orchestration and rapid prototyping) and **Pydantic AI** (lean, type-safe, built for production reliability), I went with Pydantic AI. And for the first time, my agent got a real goal: **send a personalized WhatsApp message about the weekly Parashat HaShavua, connecting it to this week's news in Israel.**

The agent runs as a single task — no chat loop — so everything is configured with environment variables (`GEMINI_API_KEY`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `NEWS_API_KEY`, `RECIPIENT_PHONE_NUMBER`, and an optional `RABBI`), then:

```
uv run my-agent
```

### The agent loop, for free

Remember the loop I wrote by hand in Phase 1? Pydantic AI does it for me — call the model, run the tool, feed the result back, and repeat until the model is done. The model can chain several tools one after the other (news → articles → send) and my whole entry point shrinks to this:

```python
def run_agent():
    recipient_phone_number = os.environ.get('RECIPIENT_PHONE_NUMBER')
    rabbi = os.environ.get('RABBI')
    prompt = f"Send to {recipient_phone_number}"
    if rabbi:
        prompt += f", based on articles by {rabbi}"
    result = agent.run_sync(prompt)
    print(result.output)
```

### Tools are just functions

No more hand-written JSON schemas! A tool is a regular Python function registered with `@agent.tool_plain`, and Pydantic AI builds the schema from the type hints and the docstring:

```python
@agent.tool_plain
def fetch_israeli_news_headlines(query: str = "Israel", max_articles: int = 100) -> list[dict]:
    """Fetch Israeli news headlines from the past week to inform the Parasha message.

    :param query: Search terms to filter news by (defaults to "Israel")
    :param max_articles: Maximum number of articles to return (defaults to 100)
    :return: A list of recent articles with title, description, source, url and published date
    """
    return fetch_israeli_news(query, max_articles)
```

> This means the docstring is part of the prompt. A vague parameter description = a model that sends the wrong arguments.

### Model agnostic

The model is just a string. Switching providers or models is a one-line change, which solves the coupling problem from Phase 2:

```python
agent = Agent(
    'google:gemini-3.5-flash-lite',
    instructions=...,
)
```

It also turned model choice into a trade-off I can actually tune — capability vs. cost vs. speed.

### Context engineering

There are two ways to give the model knowledge:

* **Inject it into the instructions** — this week's Parasha is fetched from [Sefaria](https://www.sefaria.org) when the process starts and embedded in the system prompt, because every run needs it.
* **Let the model fetch it with a tool** — news and Rabbis' articles, where the model decides what to ask for.

```python
jewish_events = get_coming_jewish_events()  # Sefaria Calendars API

agent = Agent(
    'google:gemini-3.5-flash-lite',
    instructions=(
        ...
        f"## Jewish Calendar Context\n"
        f"{jewish_events}\n\n"
    ),
)
```

Deciding what goes into the prompt upfront and what the model should retrieve by itself is a big part of building an agent.

### Grounding

LLMs love to make things up — especially when it comes to Torah. So instead of letting the model invent a Dvar Torah, I give it real articles by Rabbis (Sacks, Riskin, Rav Kook, Sivan Rahav-Meir and more) and ask it to draw on them. The model must also return the source article URL, so every message cites where it came from.

The articles are downloaded ahead of time by scripts into `res/parashot_articles/`, so the tool only reads local files:

```python
def get_parasha_articles(parasha: str, rabbi: str) -> list[dict]:
    ...
    articles_path = ARTICLES_DIR / matches[0] / f"{_slugify(parasha)}.json"
    if not articles_path.exists():
        return []

    data = json.loads(articles_path.read_text(encoding="utf-8"))
    return data.get("articles", [])
```

This is a poor man's RAG — lookup by Parasha name instead of semantic search. Real RAG is the next step.

### LLM for creativity, code for structure

At first, the model wrote the whole message. The result? Titles, formatting and links changed every run. Now the model writes only the creative part (the דבר תורה), and a plain Python template adds the title, the Parasha summary and the link:

```python
def build_parasha_message(parasha: str, description: str, dvar_torah: str, article_url: str) -> str:
    return (
        f"*{parasha}*\n\n"
        f"*תקציר הפרשה*\n"
        f"{description}\n\n"
        f"*דבר תורה*\n"
        f"{dvar_torah}\n\n"
        f"{article_url}"
    )
```

The send tool takes only the creative pieces from the model and assembles the rest itself:

```python
@agent.tool_plain
def send_parasha_whatsapp(recipient_phone: str, dvar_torah: str, article_url: str) -> str:
    message_text = build_parasha_message(
        parasha=jewish_events.get("parasha"),
        description=jewish_events.get("description"),
        dvar_torah=dvar_torah,
        article_url=article_url,
    )
    response = send_whatsapp_message(recipient_phone, message_text)
    return f"Message sent successfully: {response}"
```

> Rule of thumb: let the LLM do judgment and writing, and let code do everything that must be exact.

### Self-correcting tools

What happens when the model asks for a Rabbi that doesn't exist? Instead of crashing, the tool raises `ModelRetry`, and the model gets the error message and another chance. I also added a `list_available_rabbis` tool so the model can discover the valid options by itself:

```python
@agent.tool_plain
def fetch_parasha_articles(parasha: str, rabbi: str = "sacks") -> list[dict]:
    try:
        return get_parasha_articles(parasha, rabbi)
    except ValueError as e:
        raise ModelRetry(str(e)) from e


@agent.tool_plain
def list_available_rabbis() -> list[str]:
    return list_rabbis()
```

It's the same "errors as data" idea from Phase 1 — except now the framework turns the error into a retry for me.

### System prompt as a spec

The system prompt grew from a single sentence into a real spec: a numbered workflow, filters, defaults, constraints and tone:

```python
f"## Your Workflow\n"
f"1. **Gather current news** – Use your tool to fetch Israeli news headlines from the past week."
f"Use the news in an optimistic way only. Use only articles relevant for the Parasha, no more than 3.\n"
f"2. **Gather Parasha source material** – ... If the user did not name a Rabbi, use \"sacks\"\n"
f"3. **Write the דבר תורה** – ... Do not write a title, headers, or a link yourself\n"
f"4. **Send the message** – Call your send tool with the דבר תורה text and the exact `url` ...\n\n"

f"## Tone & Style\n"
f"- Hebrew only\n"
f"- Respectful and inclusive of all Jewish denominations\n"
f"- Engaging, not preachy\n"
```

### Observability

How do you debug an agent? You can't just look at the final output — you need to see what the model decided along the way. [Logfire](https://pydantic.dev/logfire) traces every model call, tool call and its arguments, with two lines:

```python
logfire.configure(service_name="my-agent")
logfire.instrument_pydantic_ai()
```

### From chatbot to autonomous task

The agent doesn't chat anymore. It gets a single goal ("send to X, based on Rabbi Y") and runs the whole workflow by itself. Chat is just one way to use an agent — a background task that can be scheduled is another.

## The Journey So Far

1. **Chat loop basics** — system prompts, message roles, context windows.
2. **Tool calling** — schemas, execution loops, feeding results back.
3. **Security thinking** — path confinement, size limits, errors-as-data.
4. **Capability limits** — small local models hallucinate under pressure; prompt engineering isn't a fix.
5. **Vendor coupling** — SDKs are comfortable but lock you in; frameworks aim to be agnostic.
6. **Real agents** — context engineering, grounding, code-owned structure, self-correcting tools, observability.

## What I'd Tell Someone Starting Out

- **Build one agent by hand before touching a framework.** Nothing teaches the tool-calling loop like writing it yourself — and you'll appreciate what the framework does for you.
- **Design tools with security in mind from day one.** It's not an afterthought, it's the default.
- **Know your model's limits.** A 3B local model convinced me — and itself — about a file it had never seen.
- **Think about lock-in early.** Whether you use a vendor SDK or a framework is a long-term decision, not a shortcut.
- **Ground the model and let code own the structure.** Give it real sources to draw on, and never let it improvise what must be exact.

The takeaway for me? Agents are less about the model being clever and more about the loop, the tools, and the guardrails you build around them. The model gets the spotlight, but the scaffolding is what makes it work.

---

*Part of an ongoing series. Next up: replacing the poor man's RAG with real semantic search over the Parashot.*
