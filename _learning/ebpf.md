---
layout: post
title: "Tracing TCP Connections with eBPF: A kprobe Deep-Dive"
date: 2026-08-11
category: learning
tags: [ebpf, bpf, bcc, kernel, tracing]
severity: n-a
excerpt: "Build a real-time TCP connection monitor with eBPF and BCC — kprobes, kretprobes, perf buffers, and why this pattern is the backbone of modern kernel observability."
---

# Tracing TCP Connections with eBPF

`ss` and `netstat` show you connections *that already exist*. eBPF lets you see connections **the moment they're made** — source, destination, port, PID and process name — straight from inside the kernel, with near-zero overhead.

In this writeup we build a real-time TCP connection monitor using eBPF. We'll use a `kprobe`/`kretprobe` pair on the kernel's `tcp_v4_connect()` to correlate an outgoing connection attempt with its result, and push events to user space through a **perf ring buffer**.

## Why eBPF (and why kprobes)

eBPF is a kernel virtual machine that lets us safely execute small, verified programs inside the kernel. Two properties make it the modern answer to kernel instrumentation:

- **Safety by construction** — programs are JIT-compiled and passed through a verifier that rejects anything that can crash or hang the kernel.
- **Zero-instrumentation** — unlike `LD_PRELOAD` tricks or patched kernels, nothing about the traced functions changes.

**kprobes** let us hook *any* kernel function — entry (`kprobe`), return (`kretprobe`), or both. That entry/return pair is the key to correlating *attempt* with *outcome*, which is exactly what `tcp_v4_connect()` requires: the remote address and port are only populated in the socket by the time the function **returns successfully**.

## Setting up

Install the BCC toolchain, which bundles the C-to-eBPF compiler, loader, and Python bindings:

```bash
sudo apt install bpfcc-tools
```

> Requires a kernel built with eBPF support (any modern distro kernel) and root privileges to load programs.

## The eBPF program

The full monitor lives in one Python file. Let's break it into layers: the C program that runs in the kernel, and the Python harness that runs in user space.

### Layer 1 — the kernel-side program

```python
#!/usr/bin/env python3
from bcc import BPF
import socket
import struct

# 1. Define the eBPF Program
ebpf_program = """
#include <uapi/linux/ptrace.h>
#include <net/sock.h>
#include <bcc/proto.h>

struct data_t {
    u32 pid;
    char comm[TASK_COMM_LEN];
    u32 saddr;
    u32 daddr;
    u16 dport;
};

// Allocate a perf ring buffer to send events to user space
BPF_PERF_OUTPUT(events);

// Map to store the socket pointer between function entry and return
BPF_HASH(currsock, u32, struct sock *);

// 1. KPROBE: Triggers when tcp_v4_connect starts
int trace_tcp_connect_entry(struct pt_regs *ctx, struct sock *sk) {
    // Get the current PID
    u32 pid = bpf_get_current_pid_tgid();

    // Save the socket pointer in the map for this PID
    currsock.update(&pid, &sk);
    return 0;
}

// 2. KRETPROBE: Triggers when tcp_v4_connect finishes
int trace_tcp_connect_return(struct pt_regs *ctx) {
    u32 pid = bpf_get_current_pid_tgid();

    // Look up the socket pointer we saved during entry
    struct sock **skpp;
    skpp = currsock.lookup(&pid);
    if (skpp == 0) {
        return 0; // We missed the entry, ignore
    }

    // Check if the connection actually succeeded (return code == 0)
    int ret = PT_REGS_RC(ctx);
    if (ret != 0) {
        currsock.delete(&pid); // Clean up map and ignore failed connection
        return 0;
    }

    // Dereference the pointer to get the actual socket struct
    struct sock *sk = *skpp;
    struct data_t data = {};

    data.pid = pid;
    bpf_get_current_comm(&data.comm, sizeof(data.comm));

    // The kernel has now populated these fields!
    data.saddr = sk->__sk_common.skc_rcv_saddr;
    data.daddr = sk->__sk_common.skc_daddr;
    data.dport = sk->__sk_common.skc_dport;

    // Send to user space
    events.perf_submit(ctx, &data, sizeof(data));

    // Clean up the map to prevent memory leaks
    currsock.delete(&pid);

    return 0;
}
"""
```

Three mechanisms are doing the heavy lifting:

1. **`BPF_HASH(currsock, u32, struct sock *)`** — a key/value store keyed by PID, used to hand the socket pointer from the entry probe to the return probe. Without it, the kretprobe would have no way to know *which socket* the call was about.
2. **`BPF_PERF_OUTPUT(events)`** — a perf ring buffer, the eBPF-native channel for streaming events to user space with minimal copying.
3. **`PT_REGS_RC(ctx)`** — reads the return code of the traced function, so we can filter out failed `connect()` attempts before they ever reach user space.

### Layer 2 — the user-space harness

```python
# 2. Compile and Load
b = BPF(text=ebpf_program)

# Attach BOTH the entry probe and the return probe
b.attach_kprobe(event="tcp_v4_connect", fn_name="trace_tcp_connect_entry")
b.attach_kretprobe(event="tcp_v4_connect", fn_name="trace_tcp_connect_return")

print(f"{'PID':<8} {'PROCESS':<16} {'SRC IP':<15} -> {'DEST IP':<15} {'PORT':<6}")
print("-" * 65)

# 3. Callback
def print_event(cpu, data, size):
    event = b["events"].event(data)

    src_ip = socket.inet_ntoa(struct.pack("<I", event.saddr))
    dest_ip = socket.inet_ntoa(struct.pack("<I", event.daddr))
    dport = socket.ntohs(event.dport)

    print(f"{event.pid:<8} {event.comm.decode('utf-8'):<16} {src_ip:<15} -> {dest_ip:<15} {dport:<6}")

b["events"].open_perf_buffer(print_event)
while True:
    try:
        b.perf_buffer_poll()
    except KeyboardInterrupt:
        print("\nExiting...")
        exit()
```

The Python side is intentionally thin: `BPF(text=...)` compiles the C program (via clang) and loads it, we attach both probes, and a callback drains the perf buffer into a formatted table. Note the byte-order dance in user space (`<I`, `ntohs`) — kernel network structs are in network byte order.

## Running it

In one terminal, start the monitor:

```text
$ sudo python3 tcp_connect_tracer.py
PID      PROCESS          SRC IP          -> DEST IP        PORT
-----------------------------------------------------------------
1842     firefox          192.168.1.12    -> 142.250.190.46  443
1933     curl             192.168.1.12    -> 104.21.62.217   443
```

Meanwhile, trigger a connection from another shell:

```bash
curl -s https://example.com > /dev/null
```

The event lands in the table the moment the kernel's `connect()` succeeds — no polling, no packet capture, no instrumentation of the traced process.

## Why this pattern is important

The kprobe/kretprobe + hash + perf-buffer pattern is a **template**, not a one-off. Swap `tcp_v4_connect` for `vfs_read`, `do_sys_openat`, or `sched_switch` and you've built a different observability tool — this is precisely how tools like `opensnoop`, `tcpconnect`, and `funccount` work under the hood. It's also how many rootkit detectors and malware-analysis sandboxes hook kernel activity today.

## Key takeaways

1. **Entry + return probes are a state machine** — pass data between them with a `BPF_HASH`, filter on the return code.
2. **Perf buffers are the data plane** between kernel and user space; events are streamed, not polled.
3. **eBPF instruments without modifying** — the traced function and process are completely unaware.
4. **Every field read must be verifier-approved** — this is why offsets come from kernel structs (`skc_daddr`, `skc_dport`) rather than raw memory guessing.
