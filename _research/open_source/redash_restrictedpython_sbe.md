---
layout: post
title: "Redash — RestrictedPython Sandbox Escape in the Python Query Runner"
date: 2026-08-11
category: open source
tags: [rce, sandbox-escape, restrictedpython, pandas, python, open-source, websec]
severity: high
excerpt: "A RestrictedPython sandbox escape in Redash's Python query runner: calling execute_query with result_type='dataframe' hands the sandboxed script a pandas DataFrame — and DataFrame.eval() evaluates expressions outside the restricted AST, letting any authenticated user reach __import__ and run OS commands."
---

# Redash — RestrictedPython Sandbox Escape in the Python Query Runner

## tl;dr

I found a **sandbox escape leading to remote code execution** in Redash's Python query runner. Redash uses RestrictedPython to sandbox user-supplied Python queries. However, calling `execute_query(..., result_type="dataframe")` returns a **pandas DataFrame**, and pandas' built-in `eval()` method evaluates expressions through its own engine — completely bypassing RestrictedPython's restricted attribute access. From there, `@execute_query.__func__.__globals__` reaches the sandbox's own globals and recovers `__import__`, turning the "sandbox" into arbitrary OS command execution for any authenticated user who can run a Python query.

- **Vulnerability Type:** CWE-693 Protection Mechanism Failure / CWE-94 Improper Control of Generation of Code ('Code Injection')
- **Affected Component:** Redash Python query runner (`redash/query_runner/python.py`)
- **Affected Versions:** Redash 25.1.0 — latest (confirmed at time of disclosure)
- **Severity:** High

## The sandbox

The Python query runner compiles every user script with `compile_restricted` from RestrictedPython:

```python
source_code = compile_restricted(code, "<string>", "exec")
exec(source_code, restricted_globals, restricted_locals)
```

RestrictedPython works by **rewriting the AST** of the code you pass it. Every attribute access is wrapped in a guarded `getattr`, every name lookup is vetted against an allowlist of `safe_builtins`, and anything that starts with `__` is off-limits. In a correctly-restricted world, a query like:

```python
().__class__.__bases__[0].__subclasses__()   # classic escape
```

dies at compile time or at the guard layer, because `__class__`/`__bases__`/`__subclasses__` are all dunder attribute accesses that RestrictedPython strips or blocks.

That protection only holds if **every** code path the sandboxed script can touch is also restricted.

## The bug

The runner exposes a handful of helper globals to the sandboxed script. The most useful one is `execute_query`:

```python
restricted_globals["execute_query"] = self.execute_query
```

It's a static method that runs a query against another data source and optionally hands the result back as a **pandas DataFrame**:

```python
@staticmethod
def execute_query(data_source_name_or_id, query, result_type=None):
    ...
    if result_type == "dataframe" and pandas_installed:
        return pd.DataFrame(query_result["rows"])

    return query_result
```

Pandas is a *compiled, C-backed* library. When the sandboxed script calls `df.eval("...")`, the string is parsed and evaluated by pandas' own expression engine (`pandas.core.computation.eval`) — **not** by the RestrictedPython-transformed AST. Every guard RestrictedPython installed is simply skipped. The pandas expression evaluator can reference variables in the calling frame using the `@` prefix, so the sandboxed script's own globals — including the `execute_query` function object — are in scope.

### The PoC

```python
df = execute_query(1, "", result_type="dataframe")
import_ = df.eval("""@execute_query.__func__.__globals__['__builtins__']['__import__']""")
os_module = import_('os')
print(os_module.system('touch pwned'))
```

Step by step:

1. `df = execute_query(1, "", result_type="dataframe")` — returns a DataFrame. Any existing query works; the content barely matters.
2. `df.eval("@execute_query.__func__.__globals__[...]")` — pandas evaluates this expression with access to the sandbox's globals. `@execute_query` pulls the *real* staticmethod object out of the restricted globals, `.__func__` unwraps it to the underlying function, and `.__globals__` gives the module globals that were used to exec the sandbox — including `__builtins__`.
3. `import_ = df.eval(...)` — the recovered `__import__` is just a value sitting in a variable now. Calling it is a plain name call, which RestrictedPython has no reason (and no way) to intercept.
4. `os_module = import_('os')` / `os_module.system('touch pwned')` — arbitrary OS command execution on the Redash server.

## Root cause analysis

This is a classic **"the sandbox is only as strong as the escape hatches you hand it"** failure:

- RestrictedPython guards *your* AST, but it can't guard what a C extension does with a string.
- `execute_query(..., result_type="dataframe")` returns a live, fully-featured pandas object into the sandboxed scope.
- pandas' `DataFrame.eval()` / `DataFrame.query()` are documented as able to run arbitrary code ("Warning: This function can run arbitrary code...") and deliberately resolve `@name` references against the calling scope.
- The calling scope *is* the sandbox's global namespace, which necessarily contains `execute_query` — and the whole `redash.query_runner.python` module globals hang off `__func__.__globals__`.

Put together: the safe builtins never see the pandas eval path, dunder access never passes through the restricted `getattr`, and the sandbox boundary evaporates.

### Why `__builtins__` isn't the only problem

Even if Redash scrubbed `__builtins__` from the recovered globals, the pandas eval surface is enormous. `@execute_query.__func__.__globals__` already exposes the entire module namespace: `sys`, `importlib`, `pd` (pandas itself), and every other import in `query_runner/python.py`. From there, paths like `@execute_query.__func__.__globals__['pd'].compat.os.system('id')` reach `os` through pandas' own imports with zero dunder walking. The fix has to remove the *mechanism*, not chase the payloads.

## Fixing it

The correct remediation is to **stop exposing unrestricted pandas evaluation surfaces to the sandbox**:

1. **Don't return raw pandas objects into the restricted scope.** Wrap `DataFrame`s in a proxy/interface that only exposes safe methods (`to_dict`, `to_json`, ...) and has no `eval`/`query`/`pipe`/`apply` — or convert the result to plain dicts/lists before it crosses the sandbox boundary.
2. **Pin pandas' eval surface.** If raw DataFrames must remain, monkey-patch/disable `DataFrame.eval` and `DataFrame.query` (and review `pipe`, `apply`, `map`, `groupby.apply`, pickling helpers) before they enter the sandbox.
3. **Defense in depth:** re-`compile_restricted` the *result* objects' dangerous methods, and treat the Python query runner as high-trust: gate it behind `sudo`-style permissions so only users who could anyway run arbitrary code on the box can use it.

Short term, operators should **disable the Python query runner entirely** (`REDASH_ADDITIONAL_QUERY_RUNNERS`) unless it is genuinely required, and restrict which users can create/run Python queries.

## Responsible disclosure

This was filed as [getredash/redash#7784](https://github.com/getredash/redash/issues/7784). An email was sent to `security@redash.io`; as no response was received, the issue was published publicly to reach the maintainers from that channel. Reproduced against a self-hosted Redash instance used for security research — no production deployment was impacted.
