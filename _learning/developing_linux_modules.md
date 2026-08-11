---
layout: post
title: "Developing Linux Kernel Modules: From Source to Signed Load"
date: 2026-06-17
category: learning
tags: [kernel, linux, modules, secure-boot, drivers]
severity: n-a
excerpt: "A hands-on introduction to Linux Loadable Kernel Modules (LKMs) — building, signing for Secure Boot, and verifying your first driver in the kernel ring buffer."
---

# Developing Linux Kernel Modules

## But... why?

The Linux kernel is designed around a **modular architecture**. Loadable Kernel Modules (LKMs) let the operating system dynamically extend its own core functionality at runtime — without rebooting and without recompiling the whole kernel. This is what makes it possible to hot-swap device drivers, filesystems, and security hooks (think `iptables`, `eBPF`, or `kprobes`) while the system keeps running.

From an attacker's perspective, LKMs are also the *native* weapon of choice for persistence and privilege escalation. Understanding how they load, sign, and execute is foundational for both building systems and defending them.

## Anatomy of a minimal module

Every kernel module starts with two mandatory entry points, wired up through two macros:

```c
#include <linux/init.h>    // Needed for the macros __init and __exit
#include <linux/module.h>  // Needed by all kernel modules
#include <linux/kernel.h>  // Needed for KERN_INFO log level

// Metadata about the module — exposed via /sys/module/<name>
MODULE_LICENSE("GPL");
MODULE_AUTHOR("HomiGrotas");
MODULE_DESCRIPTION("A simple Linux kernel module");
MODULE_VERSION("6.7");

// Called when our module is loaded
static int __init hello_init(void) {
    printk(KERN_INFO "Hello, Kernel! Driver loaded successfully.\n");
    return 0;
}

// Called when our module is unloaded
static void __exit hello_exit(void) {
    printk(KERN_INFO "Goodbye, Kernel! Driver unloaded safely.\n");
}

module_init(hello_init);
module_exit(hello_exit);
```

A few things worth calling out:

- **`printk`** is used because there is no `stdout` inside kernel space. `printk` writes to the **kernel ring buffer**, which you can inspect with `dmesg`.
- **`__init` / `__exit`** markers let the kernel free the code from memory once the module is loaded/unloaded, reducing kernel memory footprint.
- **`module_init()` / `module_exit()`** tell the kernel which functions to invoke when the driver is inserted or removed.
- The `MODULE_*` macros populate metadata that is visible under `/sys/module/<name>` — handy for triaging a module's provenance and version.

## Building the module

Unlike user-space code, kernel modules are **not** linked against libc. They are compiled against the *current kernel's build artifacts*. The conventional way is a `Makefile`:

```makefile
obj-m += hello_driver.o

all:
	make -C /lib/modules/$(shell uname -r)/build M=$(PWD) modules

clean:
	make -C /lib/modules/$(shell uname -r)/build M=$(PWD) clean
```

> **Note:** The kernel source headers (`linux-headers-$(uname -r)`) must be installed, and the running kernel's `.config` must have been generated, for the build to succeed.

Running `make` produces `hello_driver.ko` — a **relocatable ELF** targeting the exact kernel version running on your machine.

## Loading the module

Loading is done with `insmod` (or `modprobe`, which also resolves dependencies):

```bash
sudo insmod hello_driver.ko
insmod: ERROR: could not insert module hello_driver.ko: Key was rejected by service
```

Oops. We can't install our freshly-built module — **it isn't signed**.

### Why? Secure Boot

Modern machines ship with **Secure Boot** (UEFI), a firmware-level chain of trust that refuses to execute *unsigned or untrusted* code in kernel space. This is a deliberate mitigation against **rootkits**: a rootkit's core trick is injecting a malicious LKM, so Secure Boot blocks any module that doesn't carry a cryptographic signature trusted by the machine's firmware.

Since we just compiled `hello_driver.ko` ourselves, it has no signature from a key the firmware knows about — hence the rejection. Note that we can't just disable Secure Boot if we want to keep the platform's protection; instead, we **enroll our own key** into the Machine Owner Key (MOK) database.

## Signing our module (the right way)

### 1. Generate a key pair

```bash
openssl req -new -x509 -newkey rsa:2048 -keyout MOK.priv \
        -outform DER -out MOK.der -nodes -days 1 \
        -subj "/CN=MyLocalDriverKey/"
```

This creates a self-signed certificate. The `.priv` is the signing key; the `.der` is the public certificate we'll enroll.

### 2. Enroll the key in the machine's MOK list

Enroll via `mokutil` and reboot:

```bash
sudo mokutil --import MOK.der
```

During the next boot, the MOK Manager (a firmware utility) prompts for confirmation and a one-time password. After accepting, the key becomes trusted.

### 3. Sign the module

The kernel ships a `sign-file` helper inside the build directory:

```bash
sudo /usr/src/linux-headers-$(uname -r)/scripts/sign-file \
        sha256 ./MOK.priv ./MOK.der hello_driver.ko
```

### 4. Load it

```bash
sudo insmod hello_driver.ko
```

No error this time — the module was accepted.

## Verifying the module is running

Kernel messages land in the ring buffer:

```bash
sudo dmesg | tail
```

```text
[  847.821264] Hello, Kernel! Driver loaded successfully.
```

And the module itself is now visible to the kernel's module subsystem:

```bash
lsmod | grep hello
```

To tear it down:

```bash
sudo rmmod hello_driver
```

## Where the module lives in `/sys`

While loaded, the module exposes a small virtual filesystem surface:

```bash
cat /sys/module/hello_driver/version   # 6.7
cat /sys/module/hello_driver/refcnt    # 0
```

This is the same interface used by tools like `lsmod` and `modinfo`.

## Key takeaways

1. **Kernel modules are just relocatable ELF binaries** — loaded at runtime, linked against the running kernel's symbols.
2. **Secure Boot is a rootkit mitigation.** Signing with a MOK-enrolled key keeps the chain of trust intact while letting you load your own code.
3. **The lifecycle is always the same:** `module_init` → `module_exit`, and logging goes through `printk`/`dmesg`, never `printf`/`stdout`.

Want to see everything currently loaded on your machine? `lsmod` is your friend — every one of those lines was a module_init call that succeeded.
