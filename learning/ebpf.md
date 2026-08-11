```bash
sudo apt install bpfcc-tools
```

code:
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
