# Agent mesh

Twelve agents never call each other. Each one publishes typed messages to a shared bus and reads only the topics it declared, so the **bus** is the only coupling.

Edges pulse as messages flow between a pair of agents and are coloured by priority: red for the reflex missile chain, amber for urgent advice, blue for routine traffic.

- **ORCH** alone turns advice into directives for the aircraft.
- **PIA** alone decides what you hear.
- Click an agent to see what it reads, what it writes, its rate and its CPU time.
