---
# HOW TO USE: copy this file, rename it (for example: cyberdefenders-web-investigation.md),
# fill in everything below, and delete the guidance lines. The file name becomes the address:
# cyberdefenders-web-investigation.md  ->  /writeups/cyberdefenders-web-investigation/
# Files starting with an underscore, like this one, are never published.
title: "Short, specific title: what you investigated"
description: "One or two sentences: the situation, and what you found."
date: 2026-10-15
platform: "CyberDefenders"        # or Blue Team Labs Online, LetsDefend, Home lab
category: "Network forensics"     # or Memory forensics, Disk forensics, Log analysis
difficulty: "Medium"              # Easy, Medium, or Hard (delete the line if not relevant)
tools: ["Wireshark", "Zeek", "NetworkMiner"]
draft: true                        # change to false when it is ready to go live
---

<!--
Before publishing, check two things:
1. The platform's writeup rules. Many platforms do not allow public solutions for active
   challenges. Publish only what the rules allow, and link to the challenge page.
2. Nothing from your job. No employer data, hostnames, IPs, screenshots, or tool details.
   Lab and practice data only. Blur anything personal in screenshots.
-->

## Summary

Two or three sentences a hiring manager can read in ten seconds: what happened, how you
proved it, and the single most important finding.

## Scenario

What you were given and what you were asked to find. Put it in your own words rather than
copying the challenge text.

## Evidence

| Item | Type | Notes |
| --- | --- | --- |
| capture.pcap | Network capture | 1.2 GB, about 40 minutes of traffic |

## Investigation

Walk through your steps in the order you actually took them. For each step, say what
question you were trying to answer, what you ran, and what it showed.

### 1. First look at the traffic

What you checked first and why.

```bash
zeek -r capture.pcap
cat conn.log | zeek-cut id.orig_h id.resp_h id.resp_p service | sort | uniq -c | sort -rn | head
```

What the output told you, and where it pointed you next.

### 2. Following the lead

Include dead ends too. Showing how you ruled something out is evidence of real analysis.

## Findings and timeline

| Time (UTC) | Event | Evidence |
| --- | --- | --- |
| 14:02:11 | First contact from the suspicious host | conn.log, frame 1832 |

## Indicators of compromise

| Type | Value | Context |
| --- | --- | --- |
| IP | 203.0.113.10 | Command and control server |

## Detection and response

This is the blue team part, and often the most valuable section for employers. How would you
detect this in a real environment (a SIEM query, an EDR rule, a Zeek or Suricata signature)?
What would you contain first, and what would you change to prevent it?

## What I learned

One short paragraph: a new tool, a technique, or a mistake you will not make again.
