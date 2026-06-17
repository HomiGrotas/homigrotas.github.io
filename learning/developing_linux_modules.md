# Developing Linux Modules
## But... why?
Linux uses kernel modules (Loadable Kernel Modules, or LKMs) to provide a flexible, modular architecture. They allow the operating system to dynamically load and unload code at runtime, extending the core kernel's functionality without requiring system reboots.

## Let's build our first Linux module!
```c
#include <linux/init.h>      // Needed for the macros __init and __exit
#include <linux/module.h>    // Needed by all kernel modules
#include <linux/kernel.h>    // Needed for KERN_INFO log level

// Metadata about the module
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
We use `printk` since it logs messages to the kernel ring buffer instead of standard output (stdout), as there is no terminal environment inside the kernel.

The `module_init()` / `module_exit()` Macros tell the kernel which functions to execute when the driver is inserted or removed.

## Running our module
To run our module we will use the linux command `insmod`:
```bash
sudo insmod hello_driver.ko
> insmod: ERROR: could not insert module hello_driver.ko: Key was rejected by service
```
Oops... we can't install our module as itsn't signed. <br>
This happens beacause Secure Boot is a security standard that prevents unsigned or untrusted code from running inside the kernel space to protect your system from rootkits. Because we just compiled hello_driver.ko ourself, it doesn't have a cryptographic signature that our motherboard's UEFI trusts, so the kernel strictly blocks it.<br>
## Let's sign our module
We will create our own key using openssl:
```bash
openssl req -new -x509 -newkey rsa:2048 -keyout MOK.priv -outform DER -out MOK.der -nodes -days 1 -subj "/CN=MyLocalDriverKey/"

```
Then reboot our PC and install the key

After our machine reboot, we will sign with our new trusted key
```bash
sudo /usr/src/linux-headers-$(uname -r)/scripts/sign-file sha256 ./MOK.priv ./MOK.der hello_driver.ko
```
 and install the module
```bash
sudo insmod hello_driver.ko
```

## Verifying our module is running
```bash
sudo dmesg | tail
```
And we can see our module running, isn't it exciting?
```text
[  847.821264] Hello, Kernel! Driver loaded successfully.
```
Don't forget to remove the module using `sudo rmmod hello_driver`
Wants to see other loaded kernel modules? Use `lsmod`