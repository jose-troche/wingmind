# Engine page

Two afterburning turbofans. Spool speeds (N1, N2) lag behind the throttle; above military power the afterburner lights in five stages and fuel flow roughly triples.

Each engine runs a state machine: off, starting, idle, military, afterburner, with branches to stalled, flamed out, relighting, fire and shut down. SYS announces every fault and the checklist opens on "engine fire checklist".

- Oil pressure below 25 psi is amber, below 15 red.
- A flameout can relight below 30,000 ft with the throttle at idle.
