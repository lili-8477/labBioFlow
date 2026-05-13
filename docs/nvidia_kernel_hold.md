# NVIDIA kernel pin — why and how to undo

## Why this exists

The host runs the NVIDIA 590 driver against the Ubuntu HWE 22.04 kernel
series (`6.8.0-x-generic`). Ubuntu ships prebuilt kernel modules per kernel
version as `linux-modules-nvidia-590-6.8.0-X-generic`. When a new HWE kernel
lands in `jammy-updates` before the matching NVIDIA modules package, an
unattended-upgrades reboot leaves us booting a kernel with **no NVIDIA driver
available** — `nvidia-smi` fails and every `--gpus all` container (all
per-user `claude-bioflow-<id>` containers) exits 128 with:

```
nvidia-container-cli: initialization error: nvml error: driver not loaded
```

That happened on 2026-05-12: `linux-image-6.8.0-111-generic` was installed
but `linux-modules-nvidia-590-6.8.0-111-generic` was not yet published, and
the box rebooted into 111. Fix is to stay on the last kernel that does have
modules (currently 110) until the 111 package ships.

## What was changed

1. **GRUB default pinned to 6.8.0-110** so reboots don't fall back onto 111.

   - `saved_entry` set via `grub-set-default`.
   - `GRUB_DEFAULT=saved` in `/etc/default/grub` (without this, `saved_entry`
     is **ignored** — see "Gotcha" below).
   - `update-grub` regenerates `/boot/grub/grub.cfg`.

2. **Apt holds** on the HWE kernel metapackages so unattended-upgrades
   doesn't pull in yet another kernel without matching NVIDIA modules:

   - `linux-image-generic-hwe-22.04`
   - `linux-headers-generic-hwe-22.04`
   - `linux-generic-hwe-22.04`

   The already-installed `linux-image-6.8.0-111-generic` is not held — it
   doesn't need to be, since it's at its final version. We're stopping
   *future* kernels from arriving, not removing the existing one.

## Gotcha: `GRUB_DEFAULT=0` silently breaks `saved_entry`

`grub-set-default` writes `saved_entry=...` into `/boot/grub/grubenv`, but
GRUB only consults that file when `GRUB_DEFAULT=saved`. Ubuntu's default
is `GRUB_DEFAULT=0`, which makes GRUB always boot the first menu entry —
the top-level "Ubuntu" entry, which auto-resolves to the newest kernel.
So setting `saved_entry` without also flipping `GRUB_DEFAULT` to `saved`
looks like it worked (`grub-editenv list` shows the right value) but does
nothing on the next normal reboot. The one-shot `grub-reboot` mechanism
(which writes `next_entry`) is read regardless of `GRUB_DEFAULT`, so it
keeps working — that's why our first one-shot succeeded but the later
unattended reboot failed.

## How to undo (when `linux-modules-nvidia-590-6.8.0-111-generic` ships)

Track availability:

```
apt-cache search linux-modules-nvidia-590-6.8.0-111-generic
```

When it appears in the search output, install it and restore normal kernel
update behavior:

```
sudo apt-mark unhold \
  linux-image-generic-hwe-22.04 \
  linux-headers-generic-hwe-22.04 \
  linux-generic-hwe-22.04
sudo apt update
sudo apt install -y linux-modules-nvidia-590-6.8.0-111-generic
sudo sed -i 's/^GRUB_DEFAULT=.*/GRUB_DEFAULT=0/' /etc/default/grub
sudo update-grub
sudo reboot
```

After the reboot, verify:

```
uname -r                    # should report 6.8.0-111-generic
nvidia-smi                  # should list the RTX 3090, driver 590.x
docker ps                   # all claude-bioflow-* user containers Up
```

## Emergency: stuck on a broken kernel again

If a reboot lands on a kernel with no NVIDIA modules and you need GPU back
without reinstalling packages, one-shot into the last good kernel:

```
sudo grub-reboot "Advanced options for Ubuntu>Ubuntu, with Linux 6.8.0-110-generic"
sudo reboot
```

The override only applies to the next boot and clears itself after.
