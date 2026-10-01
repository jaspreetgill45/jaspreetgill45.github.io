---
title: "Why my VPN kill switch broke DNS: tracing a hidden NRPT rule with WFP drop logs"
description: "Turning on the WireGuard kill switch on Windows killed all DNS. Packet drop auditing showed every blocked packet was DNS to Tailscale's resolver, which led to a system-wide NRPT rule that survived even quitting Tailscale."
date: 2026-10-01
platform: "Home lab"
category: "Log analysis"
difficulty: "Medium"
tools: ["Windows Filtering Platform", "PowerShell", "WireGuard", "Tailscale"]
draft: false
---

## Summary

On my Windows desktop, enabling WireGuard's kill switch broke all DNS, even though the tunnel
itself was connected. Two reasonable fixes did nothing, so I stopped guessing and turned on
Windows Filtering Platform (WFP) packet drop auditing. Every dropped packet was a DNS query to
Tailscale's resolver at `100.100.100.100`. That led me to a Name Resolution Policy Table (NRPT)
rule, installed by Tailscale, that sent DNS for every domain on the system to its own
resolver, and that stayed in place even after Tailscale was quit. Removing the rule fixed the
kill switch and a DNS leak at the same time.

## Environment

- Windows desktop with a WireGuard full tunnel to my own VPS, which runs its own DNS
  resolver (see [the build writeup](/writeups/private-vpn-gateway-oracle-cloud/))
- Tailscale installed for reaching my other devices
- A busy network stack: Wi-Fi, Ethernet, Hyper-V and WSL virtual adapters, Bluetooth, and the
  Tailscale and WireGuard adapters

## The symptom

WireGuard's "Block untunneled traffic" option is the kill switch. If the tunnel drops, it
blocks traffic instead of letting it fall back to my ISP unencrypted. With it on, the tunnel
showed as connected, but no website would load and DNS lookups failed. With it off,
everything worked, but without the protection.

## Dead ends first

These are worth recording, because each one ruled something out.

1. **Adapter DNS settings.** I reset the DNS servers on the Tailscale adapter. No change.
2. **Quitting Tailscale.** If Tailscale was the problem, quitting it should fix it. It did not.
3. **Hyper-V and WSL virtual adapters.** These can conflict with full tunnel VPNs, and they
   were a real suspect. Instead of disabling things one by one, I decided to get evidence.

At this point I had spent a lot of time on theories. The kill switch is enforced by the
Windows Filtering Platform, and WFP can log exactly what it drops, so the logs could settle it.

## Getting ground truth: WFP packet drop auditing

From an administrator PowerShell session, I turned on auditing for dropped packets, cleared
the Security log so only fresh events would appear, and reproduced the failure:

```powershell
auditpol /set /subcategory:"Filtering Platform Packet Drop" /success:enable /failure:enable
wevtutil cl Security
# Then: enable the kill switch and try to load a website
```

Each dropped packet is logged as event ID 5152. The raw events are long XML, so I parsed the
useful fields into a table:

```powershell
Get-WinEvent -FilterHashtable @{LogName='Security'; Id=5152} -MaxEvents 25 | ForEach-Object {
  $d = ([xml]$_.ToXml()).Event.EventData.Data
  [PSCustomObject]@{
    App  = ($d | Where-Object Name -eq 'Application').'#text'
    Dst  = ($d | Where-Object Name -eq 'DestAddress').'#text'
    Port = ($d | Where-Object Name -eq 'DestPort').'#text'
  }
} | Format-Table -Auto
```

Auditing every dropped packet is noisy, so I turned it off right after:

```powershell
auditpol /set /subcategory:"Filtering Platform Packet Drop" /success:disable /failure:disable
```

## The evidence

The pattern was immediate and not what I expected:

| Process | Destination | Port | Note |
| --- | --- | --- | --- |
| svchost.exe | 100.100.100.100 | 53 | Tailscale's DNS resolver |
| svchost.exe | fd7a:115c:a1e0::53 | 53 | Tailscale's IPv6 DNS resolver |

Every blocked packet was DNS, sent by the Windows DNS Client service, to Tailscale's
resolver. Some of them even came from the WireGuard tunnel's own address. So Windows was not
just leaking DNS out of one adapter. Something was telling the whole system to use Tailscale's
resolver, no matter which interface the query came from. The kill switch was correctly
blocking those packets because they were not going through the tunnel, and Windows had no
fallback, so DNS died.

## Root cause: an NRPT rule for every domain

The Name Resolution Policy Table is a Windows feature that says "for names matching this
namespace, use these DNS servers." It is checked before the normal adapter DNS settings.

```powershell
Get-DnsClientNrptRule | Format-List Namespace, NameServers
```

```
Namespace   : {.}
NameServers : {100.100.100.100, fd7a:115c:a1e0::53}
```

A namespace of `.` means every domain. Tailscale's MagicDNS had installed a rule forcing all
DNS on the machine to its own resolver. That one rule explained everything:

- Resetting adapter DNS did nothing, because NRPT overrides adapter settings.
- Quitting Tailscale did nothing, because the rule is system policy, not part of the running
  service. Quitting a service does not remove the policy it installed.
- Packets from the tunnel's own address went to Tailscale's resolver, because the rule
  applies system wide.

The same rule also explained the DNS leak I had seen earlier in my leak tests, since it sent
lookups to Tailscale's resolver instead of my own.

## Fix and verification

```powershell
Get-DnsClientNrptRule | Remove-DnsClientNrptRule -Force
Clear-DnsClientCache
```

With the rule gone, I re-enabled the kill switch. DNS resolved through my own server, the
exit IP check showed the VPS instead of my home address, websites loaded, and the extended
DNS leak test showed only my own resolver.

Removing the rule by hand is temporary, because Tailscale reinstalls it when it reconnects.
The permanent fix was to turn off "Override local DNS" in the Tailscale admin console. I lose
nothing I use, since I reach my devices by their Tailscale IP addresses anyway.

## Detection and response angle

This is the part I would carry into an enterprise environment. An NRPT rule with namespace
`.` silently redirects all DNS for a machine. Whether it comes from a VPN client, leftover
software, or an attacker who wants to control name resolution, the effect is the same: the
machine trusts a resolver nobody chose on purpose.

- **Inventory:** `Get-DnsClientNrptRule` is easy to run at scale, for example as an Intune
  remediation script, and to flag any rule that was not deployed by your own policy.
- **Watch the broad ones:** a rule with namespace `.` deserves an alert, because it covers
  every domain.
- **Use WFP drop auditing for diagnosis, not monitoring:** event 5152 gave me exact answers,
  but it is far too noisy to leave on. Turn it on, reproduce, read, turn it off.

## What I learned

- **Quitting a service is not the same as removing its policy.** Software can leave system
  level configuration behind, and that configuration keeps working after the software stops.
- **Logs before theories.** Reasonable fixes based on guesses went nowhere. Reading the drop
  logs named the cause directly.
- **Know where Windows looks first.** NRPT is checked before adapter DNS settings, so
  checking adapters alone can never find a problem that lives in NRPT.
