---
title: "Building a private VPN gateway with in-house DNS on Oracle Cloud"
description: "A hardened WireGuard server on Oracle Cloud's free tier that all my devices tunnel through, with its own DNSSEC-validating resolver so no third party sees my DNS. Including the open resolver I almost exposed to the internet."
date: 2026-09-30
platform: "Home lab"
category: "Infrastructure and hardening"
difficulty: "Medium"
tools: ["WireGuard", "Oracle Cloud", "Ubuntu", "Pi-hole", "Unbound", "UFW", "Fail2Ban"]
draft: false
---

## Summary

I built my own VPN server on an Oracle Cloud Always Free instance and routed my phone, tablet,
laptop, and desktop through it. The same server runs its own DNS stack: Pi-hole for blocking,
in front of Unbound as a recursive, DNSSEC-validating resolver. DNS is resolved at the exit by
software I control, so no public resolver ever sees a query. Along the way I found that Pi-hole
v6 listens on every interface by default, which would have made my server an open DNS resolver
on the public internet. I caught it, fixed it, and verified the fix from outside.

## Goal and threat model

The goal was privacy from my home ISP and from whatever network I happen to be on: the ISP
should see only encrypted traffic to one server, not the sites I visit or my DNS queries.

I scoped the threat model on purpose. A single VPS that I own, rented from one provider, does
not protect against a state-level adversary. The provider can see decrypted traffic at the
exit, and the server is tied to my name. That is a different problem with different tools, so
it is out of scope here.

## Architecture

```
Device ── WireGuard (encrypted, UDP) ──> Home ISP sees only an encrypted stream
                                          to one cloud IP
   └──> Oracle Cloud VPS
          1. WireGuard decrypts the packet
          2. DNS resolved in-house: Pi-hole (blocklists) -> Unbound (recursive, DNSSEC) -> root servers
          3. NAT (masquerade) rewrites the source address to the VPS address
          4. Traffic leaves to the internet from the VPS, not from my home
```

The server is an Ampere ARM instance (1 OCPU, 6 GB) running Ubuntu 24.04 LTS, in a European
region. I picked the LTS release over the newest Ubuntu because the Pi-hole installer tends to
lag behind brand new releases.

## Step 1: Harden before anything else

Before installing any service, I locked the box down. My rule for every change that affects
access: never remove the old way in until the new way is proven from a fresh session, and keep
the original session open as a safety rope.

- Created my own admin user instead of using the default account
- SSH keys only: root login and password login disabled
- UFW with a default deny policy; only SSH and the WireGuard port are open to the internet
- Fail2Ban on SSH
- Automatic security updates with unattended-upgrades
- MFA on the cloud account itself, because console access can reset everything the box does

```bash
# /etc/ssh/sshd_config.d/99-hardening.conf
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
```

```bash
sudo sshd -t   # must come back clean before restarting SSH
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw enable
```

One detail that is easy to miss on Oracle Cloud: there are two firewalls. The cloud's Security
List filters traffic before it reaches the instance, and the host firewall filters it again on
the box. A port has to be opened in both, or it stays closed.

## Step 2: WireGuard

I generated the server keys on the server itself and never copied private keys anywhere,
including chats and notes. Each device has its own key pair and its own address in a private
tunnel subnet.

```ini
[Interface]
Address = 10.8.0.1/24
ListenPort = 51820
PrivateKey = <server private key, never shared>
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o enp0s6 -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o enp0s6 -j MASQUERADE
```

The `MASQUERADE` rule is what makes the server act like a router. Devices only have private
tunnel addresses, which the internet cannot route back to, so the server rewrites outgoing
packets to its own public address and remembers the mapping for the replies. IP forwarding is
enabled with `net.ipv4.ip_forward=1`.

Every client uses `AllowedIPs = 0.0.0.0/0`, so all IPv4 traffic goes through the tunnel, and
`DNS =` points at the server's tunnel address.

## Step 3: DNS at the exit

Unbound does the actual resolving. It talks directly to the root servers and validates DNSSEC
signatures, so no public resolver like Google or Cloudflare is involved. It listens only on
the tunnel address, never on the public interface.

```
server:
    interface: 10.8.0.1@5335
    access-control: 10.8.0.0/24 allow
    access-control: 127.0.0.0/8 allow
    hide-identity: yes
    hide-version: yes
    harden-glue: yes
    harden-dnssec-stripped: yes
    prefetch: yes
    edns-buffer-size: 1232
```

I tested DNSSEC both ways: a correctly signed domain returned the `ad` (authenticated data)
flag, and a domain with a deliberately broken signature was rejected with `SERVFAIL`.

```bash
dig @10.8.0.1 -p 5335 sigok.verteiltesysteme.net   # expect the 'ad' flag
dig @10.8.0.1 -p 5335 dnssec-failed.org            # expect SERVFAIL
```

Pi-hole sits in front of Unbound and blocks ad and tracking domains, with Unbound as its only
upstream.

### The finding: an open resolver by default

After installing Pi-hole v6, I checked what was actually listening instead of trusting the
installer:

```bash
sudo ss -ulnp | grep ':53'
```

Pi-hole was bound to `0.0.0.0:53`, meaning every interface, including the public one. Without
the cloud and host firewalls in front of it, that is an open resolver: anyone on the internet
could send it queries, and open resolvers are a classic tool for DNS amplification attacks.
The firewall would have blocked it, but I did not want a single control standing between my
server and that risk.

The listening mode called `SINGLE` sounded right, but on v6 it did not narrow the socket.
The mode that actually worked was `BIND`:

```bash
sudo pihole-FTL --config dns.listeningMode BIND
sudo systemctl restart pihole-FTL
sudo ss -ulnp | grep ':53'   # now only the tunnel address and localhost
```

I then allowed DNS and the Pi-hole dashboard on the tunnel interface only:

```bash
sudo ufw allow in on wg0 to any port 53 proto udp
sudo ufw allow in on wg0 to any port 53 proto tcp
sudo ufw allow in on wg0 to any port 80 proto tcp
```

That gives two independent layers: the service no longer listens publicly, and the firewall
would block it even if it did.

## Step 4: Verification

I did not consider anything finished until it was tested, from the client side and from
outside.

| Test | Expected result | Result |
| --- | --- | --- |
| Exit IP check | VPS address, not home | Pass |
| DNS leak test (extended) | Only my own resolver, no ISP or public resolvers | Pass |
| DNSSEC failure page in a browser | Must fail to load | Pass |
| Open resolver check from outside | Not detected | Pass |
| Ad domain lookup through the tunnel | Blocked (0.0.0.0) | Pass |

The DNS leak test failed at first. Two things were sending DNS around the tunnel: my browser's
built-in DNS over HTTPS, which I turned off, and a Windows DNS policy rule installed by
another VPN client. That second one took real investigation, and I wrote it up separately in
[Why my VPN kill switch broke DNS](/writeups/vpn-kill-switch-nrpt-investigation/).

A testing lesson: on a Windows machine with many network adapters, `Resolve-DnsName -Server`
gave me misleading answers. `nslookup domain <server>` reports which server actually answered,
so I used that instead. On Linux, plain `nslookup` asks the local systemd-resolved stub, so
`resolvectl query` is the better tool because it shows which link answered.

## Problems I hit along the way

**Two VPNs fighting over the default route.** At one point the tunnel connected but received
nothing. The cause was another VPN client I had installed earlier and forgotten about, which
also claimed the default route. Only one full tunnel VPN can own the default route on a
machine at a time.

**An IPv6 leak, and a fix that made things worse.** A leak check on my Fedora laptop showed my
real IPv6 address bypassing the tunnel, because the config only routed IPv4. Adding `::/0` to
`AllowedIPs` closed the leak but broke Tailscale's connection to its control servers. The
server's NAT rule was IPv4 only, so IPv6 traffic now went into the tunnel and died there. I
reverted and disabled IPv6 on that laptop instead. The lesson: routing a new address family
into a tunnel only fixes a leak if the server can actually forward that family. Otherwise the
leak is just replaced with silently dropped traffic.

**Tailscale and a full tunnel do not mix well.** I use Tailscale to reach my own devices.
While WireGuard owns the default route, Tailscale's NAT traversal sees the VPS address
instead of my real network path, and peer connections fail. The service logs showed it trying
to reach peers through addresses that were never valid paths. For now I turn the tunnel off
when I need device to device access. The proper fix is policy routing that exempts
Tailscale's own traffic from the tunnel, which is on my list.

## What this does not protect against

- **The endpoint.** Malware or a stolen, unlocked device sees everything before it is
  encrypted. The device is still the real weak point.
- **The exit.** Traffic is decrypted on the VPS, so the cloud provider is a point of exposure.
- **Detection.** There is no intrusion detection on the server yet, so I would not
  necessarily know if it were compromised.

## What I learned

Defaults deserve suspicion. The Pi-hole open resolver was not a misconfiguration on my part;
it was the default, and I only found it because I checked what was actually listening. I now
verify listening sockets and run external checks after installing any network service.

## Next steps

Deploy Wazuh on a separate free instance and ship this server's logs to it over Tailscale. It
has to be a separate box: an attacker who controls the monitored server could tamper with
logs before they leave it.
