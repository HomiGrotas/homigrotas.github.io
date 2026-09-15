---
layout: post
title: "Building AI Agents from Zero to Hero"
date: 2026-09-15
category: learning
tags: [AI, agents, ai-agents]
severity: n-a
excerpt: "Started from building AI agent from zero, and improved slowly to AI agent frameworks"
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

Funny one. My model runs locally via **Ollama** (`llama3.2`, 3B parameters). But Ollama exposes an OpenAI-compatible API, so I could use the `openai` Python package against `http://localhost:11434/v1`. Zero extra dependencies — just a different `base_url`.

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

The model never *runs* the tool — it only requests it. My code does the execution and returns the result into the conversation.

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
```

But it didn't take long to notice the trap: **using Google's SDK couples me to Gemini, period.** No swapping models, no choice. I'd traded one limitation for a different kind of lock-in.

## Where I Am Now

I'm researching the middle ground — things like **LangGraph** (expansive, feature-rich, built for complex orchestration and rapid prototyping) and **Pydantic AI** (lean, type-safe, built for production reliability). My goal: keep the control and understanding I gained by building from scratch, without handwriting everything and without being glued to one vendor.

So far the journey has been:

1. **Chat loop basics** — system prompts, message roles, context windows.
2. **Tool calling** — schemas, execution loops, feeding results back.
3. **Security thinking** — path confinement, size limits, errors-as-data.
4. **Capability limits** — small local models hallucinate under pressure; prompt engineering isn't a fix.
5. **Vendor coupling** — SDKs are comfortable but lock you in; frameworks aim to be agnostic.

## What I'd Tell Someone Starting Out

- **Build one agent by hand before touching a framework.** Nothing teaches the tool-calling loop like writing it yourself.
- **Design tools with security in mind from day one.** It's not an afterthought, it's the default.
- **Know your model's limits.** A 3B local model convinced me — and itself — about a file it had never seen.
- **Think about lock-in early.** Whether you use a vendor SDK or a framework is a long-term decision, not a shortcut.

The takeaway for me? Agents are less about the model being clever and more about the loop, the tools, and the guardrails you build around them. The model gets the spotlight, but the scaffolding is what makes it work.

---

*Part of an ongoing series. Next up: comparing LangGraph vs Pydantic AI for a production-ready agent.*

[GitHub repo](https://github.com/HomiGrotas/my-agent)