# WINGMIND — Multi-Agent Fighter Simulator: System Specification

Oct 4, 2026 · @Jose

## 1. Overview and goals

WINGMIND is a browser-based fighter simulator in which a crew of cooperating software agents acts as the pilot's digital wingman: it turns raw sensor and systems data into short spoken alerts, and accepts spoken commands back.

The simulated aircraft is a generic fifth-generation multirole fighter: single seat, twin engine, low-observable airframe, fused-sensor cockpit. Fidelity targets plausibility, not classification. Every performance figure is parametric and drawn from public, unclassified sources.

**Goals**

- **G1 Situational awareness.** Fuse every sensor into one track picture and surface the top threats within 1 s of first detection.
- **G2 Reaction time.** Reflex alerts (missile launch, ground collision) reach the pilot's ears in under 150 ms from the triggering event.
- **G3 Explainability.** Every recommendation traces to the agent and evidence behind it, and the console visualizes the concept involved.
- **G4 Hands-free operation.** A defined natural-language command set with read-back and confirmation, plus free-form questions.
- **G5 Runs anywhere.** 60 fps in a desktop browser with no install; a companion prototype fits the Cloudflare free tier.

**Audience:** flight-sim enthusiasts, aviation and STEM educators, and engineers studying multi-agent orchestration and human-machine teaming.

**Non-goals**

- No real or classified aircraft, sensor, electronic-warfare or weapon data. All models are generic and parametric.
- No real-world tactics or procedures. Adversary behavior is game AI.
- Offensive weapons employment is a later module. Version 1 focuses on awareness, survivability and systems management.
- Not a certified training device.

**Design principles**

1. Deterministic first, LLM second. Anything time-critical is rules and math; language models handle summaries, briefings and free-form commands.
2. Agents advise, the pilot decides. Only ground-collision and envelope protection may act without consent, and both can be switched off.
3. One voice. All agents speak through a single Pilot Interface agent that prioritizes and de-clutters.
4. Show the why. Every alert links to the concept visual that explains it.

## 2. System architecture

Four layers run in the browser and talk over one typed event bus; the cloud supplies only language, storage and session services.

&#91;embedded content: WINGMIND architecture · 3 browser layers, 3 cloud services\]

Stick and throttle go straight to the flight model; agents reach the aircraft only through approved directives, and every cloud call is asynchronous.

1. **Simulation Core** (Web Worker, fixed 60 Hz step). Flight dynamics, atmosphere and weather, propulsion, fuel, sensors, entities and terrain. It owns ground truth.
2. **Agent Mesh** (one or more Web Workers). Perception, assessment and advisory agents arranged in three cognition tiers (section 5).
3. **Pilot Interface** (main thread). The console (WebGL scene plus SVG and Canvas instruments), the audio engine (Web Audio plus speech synthesis) and input (HOTAS or gamepad, keyboard, mouse, voice).
4. **Cloud Services.** LLM inference for deliberative agents and free-form language, the scenario catalog, debrief storage, and an optional instructor session.

**Agents see only what sensors see.** The core publishes ground truth to the sensor models and the flight recorder, never to agents. Agents receive observations with noise, latency, gaps and false returns, so they can be wrong, exactly as a real crew can.

| Component | Runs where | Rate | Why there |
| --- | --- | --- | --- |
| Flight dynamics, sensors, entities | Browser sim worker | 60 Hz fixed | Latency and determinism |
| Reflex agents | Browser agent worker | 20–50 Hz | Alerts under 150 ms |
| Tactical agents | Browser agent worker | 2–5 Hz | Cheap utility scoring |
| Deliberative agents | Cloud LLM | Event-driven, at most 1 call per 5 s | Language and planning |
| Console and audio | Browser main thread | 60 fps | Rendering |
| Scenarios, debriefs, sessions | Cloud | On demand | Persistence and sharing |

**Deployment modes**

- **Standalone:** offline, no LLM. Templated alerts and grammar-only commands. Fully playable.
- **Connected:** adds LLM briefings, situation summaries and free-form commands.
- **Instructor:** adds an observer view, live fault injection and threat spawning over a WebSocket session.

## 3. Simulation core

The core is a deterministic, seeded physics step at 60 Hz (120 Hz internal sub-step) that owns ground truth and exposes it only through sensor models and the recorder.

### 3.1 Flight dynamics

- Six-degree-of-freedom rigid body, quaternion attitude, RK4 integration.
- Aerodynamic coefficient tables (lift, drag, side force, pitch, roll, yaw moments) indexed by Mach, angle of attack (α), sideslip (β) and control deflection, including transonic drag rise.
- Fly-by-wire control law: the stick commands G and roll rate; the law limits α and load factor (default +9 / −3 G) and blends optional thrust vectoring.
- Mass, center of gravity and inertia update continuously from fuel burn and stores.

Lift, the term every envelope visual in the console is built on:

```latex
L = \tfrac{1}{2}\,\rho\,V^{2}\,S\,C_L(\alpha, M)
```

### 3.2 Atmosphere and weather

- ISA 1976 baseline for temperature, pressure and density, with scenario offsets (hot day, cold day).
- Layered wind field, gusts from a Dryden turbulence model, wind shear near the ground.
- Cloud layers (base, top, coverage), visibility, precipitation, icing bands and convective cells with severe turbulence.
- Effects are coupled: density and temperature change thrust and lift; rain attenuates radar; cloud and humidity cut IR and visual range.

### 3.3 Propulsion

- Two afterburning turbofans. Spool speeds (N1, N2) follow first-order lags toward throttle demand.
- Thrust and fuel flow are table functions of throttle, Mach, altitude and temperature; afterburner lights in stages.
- Modeled outputs: turbine temperature, oil pressure and temperature, nozzle position, vibration, inlet distortion at high α.
- Faults: compressor stall, flameout and relight envelope, fire, bearing wear, foreign-object damage, generator loss.

### 3.4 Fuel system

- Internal tanks (forward and aft fuselage, wings, two engine feed tanks) plus optional external tanks.
- Transfer sequencing keeps the center of gravity in limits; feed tanks are protected for negative-G flight.
- Leaks, battle damage and fuel temperature are modeled; aerial refueling is a later module.

### 3.5 Sensors

All sensors are generic and parametric; scenario files tune them.

| Sensor | What it reports | Model highlights |
| --- | --- | --- |
| AESA radar | Range, bearing, elevation, closure | Radar range equation (detection range grows with the fourth root of target signature); search, track-while-scan and low-probability-of-intercept modes; look-down clutter penalty; its emissions are detectable |
| IRST | Bearing and elevation only | Passive; target heat contrast against background; cloud and humidity attenuation; range from kinematic ranging |
| Distributed aperture (360° EO/IR) | Missile launches, nearby aircraft | Plume detection out to short range; configurable false-alarm rate |
| Radar warning receiver | Emitter bearing, type, mode | Classifies search, track and guidance modes; bearing ambiguity; ambiguous emitter libraries |
| Datalink | Offboard tracks | Tracks from friendly early-warning aircraft and wingmen with 0.5–3 s latency |
| Navigation and air data | Position, attitude, airspeed, height above ground | INS drift with GPS correction; radar altimeter; GPS jamming as a scenario event |

### 3.6 Terrain and obstacles

- Height-map tiles (public elevation data or procedural) with towers, cables and buildings as obstacle primitives.
- Line-of-sight queries ray-march the height map with a quadtree for speed. They feed terrain masking, sensor occlusion and collision prediction.

### 3.7 Entities and threat models

| Entity class | Generic examples | Behavior model |
| --- | --- | --- |
| Enemy fighters | Fourth- and fifth-generation profiles | Utility-AI pilots with radar emissions, missiles and formation tactics (section 13) |
| Air-to-air missiles | Radar-guided long range, IR-guided short range | Boost, sustain and coast phases with drag; proportional-navigation guidance; seeker field-of-view and gimbal limits; countermeasure susceptibility |
| Long-range SAM sites | Search radar, tracking radar, launchers | Emission sequence search to track to guidance; engagement envelope by altitude and range |
| Short-range air defense | Shoulder-fired IR missiles, radar or optical guns | Little or no radar warning; dense at low altitude near defended points |
| Drones | ISR drone, loitering munition, swarm | Small signature, slow, low heat; swarms share targets |
| Ground radars | Early warning, fire control | Long range and coarse, or short range and precise |
| Friendly assets | Wingman, early-warning aircraft, tanker | Scripted or AI; feed the datalink |

Every profile is an illustrative table in the scenario file, so instructors can make threats easier or harder without code changes.

## 4. Agent catalog

Eighteen blue-force agents in five clusters assist the pilot; each declares its tier, rate, the topics it reads and the topics it writes, and nothing else couples them.

Tiers: **R** reflex (deterministic, sub-100 ms), **T** tactical (utility scoring, heuristics), **D** deliberative (LLM). Red-force agents are covered in section 13.

| Agent | Cluster | Mission | Key inputs | Key outputs | Tier | Rate |
| --- | --- | --- | --- | --- | --- | --- |
| ORCH Mission Orchestrator | Command | Owns mission phase, arbitrates conflicting advice, retunes agent rates per phase | All recommendations, phase events | Arbitrated directives, rate plan | T + D | 5 Hz |
| FUSE Sensor Fusion | Perception | Correlates observations into tracks, filters motion, assigns identity | Radar, IRST, DAS, RWR, datalink, IFF | Fused track table with quality and ID | R | 20 Hz |
| MAWS Missile Warning | Threat | Detects launches and inbound missiles, computes time to impact | DAS plume, RWR guidance mode, fast closing tracks | Missile threats, launch alerts | R | 50 Hz |
| AIR Air Threat | Threat | Classifies aircraft, infers intent, estimates their missile envelopes | Fused air tracks, RWR | Air threats with intent and envelope | T | 10 Hz |
| UAS Drone Threat | Threat | Finds small slow targets, clusters swarms, flags loitering | Fused tracks, EO | Drone threats, swarm groups | T | 5 Hz |
| GBAD Ground Defense | Threat | Locates SAM and gun sites, builds terrain-masked threat rings | RWR, intel, EO, terrain | Ground threats with rings and envelopes | T | 5 Hz |
| TAP Threat Prioritizer | Threat | Ranks every threat by score and time to act | All threat agents, own state | Ranked threat list | T | 10 Hz |
| SIG Signature Manager | Survivability | Computes own detectability per enemy sensor, advises aspect, altitude, throttle, emissions | Own state, threat sensors, weather | Detection map, signature advice | T | 5 Hz |
| EW Electronic Warfare | Survivability | Interprets warnings, runs countermeasure programs, sets emissions control | RWR, MAWS, ROE settings | Countermeasure commands, emission state | R + T | 20 Hz |
| NAV Navigation and Avoidance | Survivability | Threat-aware routing, terrain following, ground and mid-air collision avoidance | Route, terrain, tracks, threat rings | Steering cues, fly-up commands, re-routes | R + T | 20 Hz / 1 Hz |
| ENV Envelope Protection | Survivability | Guards angle of attack, G, speed; reports energy state | Air data, flight state | Envelope warnings, energy advisories | R | 50 Hz |
| PROP Propulsion and Systems | Systems | Monitors engines, hydraulics, electrics; diagnoses faults; drives checklists | Engine and system telemetry | Faults, checklists, health score | R + T | 10 Hz |
| FUEL Fuel and Range | Systems | Bingo and joker, range rings, divert options, leak and imbalance detection | Fuel system, route, winds | Fuel state, RTB timing, range ring | T | 1 Hz |
| WX Weather | Systems | Finds hazards on the route, predicts sensor degradation | Weather field, route | Weather hazards, sensor penalties | T | 0.5 Hz |
| PIA Pilot Interface | Interface | The single voice: queues, phrases, speaks and de-clutters every alert | All alerts, workload model | Spoken and displayed alerts | R | Event-driven |
| NLU Command Interpreter | Interface | Turns speech into validated intents with read-back | Transcript, context | Intent objects, confirmations | R + D | Event-driven |
| BRIEF Briefing and Summary | Interface | Situation summaries on request, mission brief, debrief narrative | World model snapshot, event log | Spoken summaries, reports | D | On request |
| REC Recorder | Interface | Logs every observation, decision and alert for replay and scoring | Entire bus | Replay file, metrics | R | Every tick |

## 5. How the agents work in concert

Agents never call each other. They publish typed messages to a shared bus and blackboard, and two arbiters turn many opinions into one action (ORCH) and one voice (PIA).

&#91;embedded content: Agent mesh · 4 clusters, shared bus, 2 arbiters\]

Every cluster writes to the bus; ORCH alone turns advice into directives for the aircraft, and PIA alone decides what the pilot hears.

### 5.1 Three cognition tiers

- **Reflex (R).** Pure functions over the latest snapshot, at most 2 ms per agent per tick, no I/O. Missile launch detection, ground-collision prediction, envelope limits, countermeasure dispense.
- **Tactical (T).** Utility scoring over candidate actions at 1–20 Hz, at most 5 ms. Threat ranking, re-routing, signature advice, fuel planning.
- **Deliberative (D).** Asynchronous LLM calls whose results arrive seconds later, stamped with the snapshot version they reasoned about. A result is discarded if the threat picture changed since. Summaries, briefings, free-form commands, re-plan proposals.

**A lower tier never waits on a higher one.** A missile alert never waits for a language model.

### 5.2 Blackboard

- One versioned world model in the agent worker: own state, tracks, threats, detection map, route, systems, weather, alerts, intents.
- **Single-writer rule:** each key has exactly one owner. Only FUSE writes tracks; only TAP writes the ranked threat list.
- Readers get an immutable snapshot per tick through structural sharing, so no locks are needed.

### 5.3 Event bus

- Topics: `obs.*`, `track.*`, `threat.*`, `advice.*`, `directive.*`, `alert.*`, `intent.*`, `sys.*`.
- Every message carries its source, tick, snapshot version, priority, time-to-live, confidence and evidence links back to the tracks and observations behind it.
- Delivery is in-tick and ordered by tier (reflex first), then priority.

### 5.4 Arbitration

- Advice targets a control axis: heading, altitude, throttle, emitters or countermeasures. ORCH resolves each axis into one directive.
- Compatible advice merges: "dispense chaff" from EW and "turn right" from NAV both execute.
- Conflicts resolve by the safety hierarchy first, then by weighted utility. Example: SIG wants nose-on to an enemy radar for lowest signature, MAWS wants a beam turn against an inbound missile. Missile defense ranks higher, so SIG's advice is suppressed and the reason is logged.
- Every directive carries its "why" chain, which the console shows on demand.

### 5.5 Safety hierarchy

Higher items override lower ones. Envelope protection is also a constraint on every maneuver: no directive may exceed G or angle-of-attack limits.

1. Ground collision avoidance
2. Mid-air collision avoidance
3. Inbound missile defense
4. Flight envelope protection
5. Engine fire or dual-engine emergency
6. Threat avoidance and signature management (SAM rings, fighters, drones)
7. Fuel below bingo
8. Weather hazards
9. Navigation and mission tasks

### 5.6 Phase-aware rate plan

ORCH retunes agent rates by mission phase to stay inside the CPU budget. In cruise, MAWS runs at 20 Hz and summaries are allowed. In combat, MAWS and ENV run at 50 Hz, TAP at 20 Hz, and non-urgent speech is muted. At low level, ground-collision prediction runs at 50 Hz and route planning slows to 0.2 Hz.

### 5.7 Worked example: missile launch at low altitude

1. **T+0 ms.** The distributed aperture sees a plume at left 8 o'clock; the warning receiver shows a guidance-mode emitter on the same bearing.
2. **T+20 ms.** MAWS correlates both into one missile threat: 6 nmi, 14 s to impact, high confidence. It publishes a WARNING.
3. **T+25 ms.** TAP moves the missile to rank 1.
4. **T+30 ms.** EW proposes a chaff program for a radar-guided threat. NAV evaluates beam turns: left is blocked by rising terrain, so it proposes right. ENV caps the turn at 9 G.
5. **T+35 ms.** ORCH issues one directive: break right to beam, chaff, radar silent. SIG's conflicting advice is suppressed.
6. **T+40 ms.** PIA cuts off a fuel advisory mid-sentence, plays a launch tone placed at left-rear, and speaks: "Missile, left eight, six miles. Break right, chaff." The HUD shows a break cue; the situation display flashes the missile.
7. **T+3 s.** The pilot complies. The missile's track diverges, and MAWS declares it defeated. PIA: "Missile defeated. SAM, right two, twenty miles."
8. **T+8 s.** BRIEF has composed an updated one-sentence situation summary, held until the pilot asks "status".

Every step above can be watched live in the console's agent mesh visualizer and decision trace (section 11).

## 6. Threat detection and assessment

Every threat, whatever its class, becomes one record with a score and a time-to-act, so the pilot hears the most urgent one first no matter which agent found it.

### 6.1 Detection by threat class

| Threat class | Primary cues | Agent | Typical warning | Main failure mode |
| --- | --- | --- | --- | --- |
| Radar-guided missile | Guidance-mode emitter, plume, fast-closing radar track | MAWS | 10–40 s | Silent until its seeker goes active late in flight |
| IR-guided missile | Plume only, no emissions | MAWS | 3–10 s | Plume lost in ground clutter or sun glare |
| Enemy fighter | Radar, IRST and datalink tracks; search and track emitters | AIR | Minutes | Low-observable fighters detected late |
| Drone or swarm | Small radar returns, EO, slow speed | UAS | Short | Confused with birds or clutter |
| Long-range SAM | Emitter sequence search to track to guidance; intel | GBAD | Site-dependent | Pop-up sites; terrain hides them until close |
| Short-range defense and guns | Plume, muzzle flash, optical cues | GBAD + MAWS | Seconds | No radar warning at all |
| Ground radar | Emitter type and mode | GBAD | Long | Ambiguous emitter identity |

### 6.2 Fighter intent inference

AIR classifies each enemy aircraft into one of seven states: unaware, searching, committing, intercepting, launching, defending, disengaging. Inputs are geometry (aspect, closure, nose position relative to own aircraft), emitter mode and track history. A small hidden-Markov classifier outputs a state and a confidence, and a state change is itself an alert ("Bandit, nose hot, committing").

### 6.3 Engagement envelopes

- For each enemy aircraft, AIR looks up its missile envelope against own aircraft: maximum range and no-escape range as functions of altitude, closure and aspect, interpolated from per-profile tables.
- The same tables in reverse show own envelopes for awareness.
- GBAD builds each SAM's range and altitude dome, then cuts it with line-of-sight from the site radar, so ridges carve safe corridors out of the ring.

### 6.4 Threat score

TAP scores every threat on four factors in the range 0 to 1:

```latex
\text{score} = L \times P_{\text{engage}} \times \min\!\left(1, \frac{t_{\text{ref}}}{t_{\text{act}}}\right) \times C
```

- **L, lethality:** from the threat profile.
- **P engage:** probability the threat can engage now, combining "inside its envelope" with "it can detect us" from SIG's detection map.
- **t act:** seconds until the threat can engage: time to impact for a missile, time to enter the envelope for anything else. t ref is 10 s.
- **C, confidence:** from FUSE track quality.

Score bands map to alert levels: 0.8 and up is WARNING, 0.4 to 0.8 is CAUTION, below 0.4 is ADVISORY. Hysteresis (enter at 0.8, leave at 0.7) stops an alert from flapping.

### 6.5 Fog of war

False-alarm and missed-detection rates are scenario settings. Agents always report confidence, and PIA adds "possible" for confidence between 0.5 and 0.8: "Possible launch, right four." Below 0.5, the contact shows on the display but is not spoken.

## 7. Survivability: stealth, anti-detection and obstacle avoidance

SIG, EW and NAV answer one question continuously: who can detect me right now, and what is the cheapest change that makes them stop? All models here are game-level abstractions with illustrative numbers.

### 7.1 Own signature model

- **Radar signature** is a table by azimuth and elevation, per radar band. The frontal sector is smallest; beam and rear sectors spike. Low-frequency search radars see the airframe better than high-frequency fire-control radars. Open weapon bays, external stores and battle damage raise it.
- **Infrared signature** depends on throttle (afterburner dominates), speed (skin heating), aspect (the tail is hottest), altitude and background.
- **Emissions signature** comes from own radar mode, datalink, radar altimeter and radios, each detectable by enemy receivers within a range.
- **Visual signature** includes contrails, predicted from altitude, temperature and humidity.

### 7.2 Detection map

For each known enemy sensor, SIG computes the probability that it detects own aircraft now. It uses own signature at the aspect that sensor sees, the sensor's mode, terrain line-of-sight and weather attenuation. The console draws each result as a detection ring that shrinks and grows as the pilot turns, plus a heat map of detection probability for candidate headings and altitudes.

### 7.3 Anti-detection advice

- **Aspect management.** Keep the low-signature sector toward the most dangerous radar: "Come right 20 to stay nose-on to the search radar."
- **Terrain masking.** Descend behind a ridge to break line-of-sight; NAV must approve terrain clearance first.
- **Throttle discipline.** Come out of afterburner when IR threats are near.
- **Emissions control.** Four levels, from unrestricted to fully silent (passive sensors only), with a low-probability-of-intercept radar level in between. "Radar silent" is a one-word command.
- **Configuration.** Keep bays closed and avoid external stores in defended airspace.
- **Contrail avoidance.** Recommend an altitude band outside the contrail layer.

### 7.4 Countermeasures and anti-radar measures

- EW models chaff (radar decoy), flares (IR decoy), an expendable decoy and an abstract self-protection jammer. Each is a probability modifier on an enemy's track quality or seeker lock, shaped by geometry and timing.
- A self-protection jammer lowers enemy track quality until a burn-through range, but it is itself an emission, so SIG weighs it against detectability.
- **Programs and modes.** Pilots select dispense programs. Manual, semi-auto (EW proposes, pilot consents by button or "dispense") and auto (EW responds to MAWS warnings) modes are supported.
- Inventory is tracked, with "Chaff low" and "Flares out" cautions.

### 7.5 Obstacle and collision avoidance

- **Ground collision avoidance.** Every tick NAV projects a recovery maneuver (roll wings level, pull at the G limit). If predicted clearance drops below a buffer (default 150 ft plus terrain-data uncertainty), it warns "Pull up" 2 s early and, if enabled, flies the recovery and returns control once clear.
- **Obstacles.** Towers and cables are announced with bearing, range and height: "Tower, twelve o'clock, two miles, four hundred feet."
- **Mid-air collision.** Closest point of approach for every track triggers "Traffic" and, if enabled, an automatic avoidance maneuver.
- **Terrain following.** NAV builds a set-clearance flight path (default 500 ft above ground) from a look-ahead terrain profile, merged with masking advice.
- **Threat-aware routing.** An A\* planner searches a cost grid, re-plans when threats appear, and offers the result: "New route avoids the SAM, adds four minutes, fuel is fine. Accept?"

```latex
\text{cost}(cell) = d + w_1 P_{\text{detect}} + w_2 E_{\text{envelope}} + w_3 H_{\text{weather}} + w_4 F_{\text{fuel}}
```

The weights shift with mission phase: exposure dominates in defended airspace, fuel dominates on the way home.

## 8. Aircraft systems and instruments

The console carries every instrument a fused-cockpit fighter pilot needs, each with green, amber and red bands that match the alert levels, and each fed by the same telemetry the agents read.

| Display | Shows | Agent cues drawn on it |
| --- | --- | --- |
| Head-up display | Pitch ladder, flight-path marker, heading tape, airspeed and Mach, barometric and radar altitude, vertical speed, G (current and max), angle of attack | Break cue, pull-up cue, steering cue, missile warning flash |
| Standby instruments | Attitude, altitude, airspeed (backup set) | None, by design |
| Tactical situation display | Own ship, fused tracks colored by identity, route and waypoints, range rings, bullseye, weather cells | Threat rings cut by terrain, missile envelopes, own detection rings, proposed re-routes |
| Warning receiver scope | Emitter symbols by bearing and lethality | Priority emitter highlighted, launch flashing |
| Engine page | N1 and N2 %, turbine temperature, nozzle %, oil pressure and temperature, fuel flow, thrust %, afterburner stage, vibration | Fault annunciations, live checklists |
| Fuel page | Tank diagram with quantities, total, flow, bingo and joker marks, time and range remaining, fuel needed to return, center of gravity | Range ring, RTB countdown, leak and imbalance alerts |
| Systems synoptic | Two hydraulic systems, generators and battery, oxygen, cabin pressure, gear, flaps, brakes | Failed components drawn red with the checklist beside them |
| Defensive systems | Chaff and flare counts, dispense program, emissions-control level, jammer state | Recommended program, low-inventory cautions |
| Weather panel | Winds aloft, outside air temperature, icing, turbulence, cloud layers, visibility | Hazards ahead on the route, sensor penalties |
| Navigation page | Active waypoint, distance, time en route and arrival, INS and GPS status | GPS-jamming warning, drift estimate |
| Master caution and warning | Two master lights plus an annunciator grid | Every WARNING and CAUTION from PIA |

**Engine state machine.** Each engine runs off → starting → idle → military → afterburner stages 1–5, with branches to stalled, flamed out, relighting, fire and shut down. Every transition is published to the bus, so PROP can explain it ("Left engine flameout, relight window below 30 thousand").

**Units** default to knots, feet, nautical miles, pounds and pounds per hour, and °C; a toggle switches to metric. Colors follow cockpit convention: red warning, amber caution, green or cyan advisory and normal.

## 9. Natural language alerts

Alerts follow a fixed grammar (what, where, how far, what to do), and every time-critical one is a template rather than LLM output, so it is speaking within 150 ms.

### 9.1 Alert levels

| Level | Meaning | Sound | Speech | Visual | Interrupts |
| --- | --- | --- | --- | --- | --- |
| WARNING | Act within seconds | Distinct tone, placed in 3D at the threat bearing | Repeats until acknowledged or cleared, at most 3 times | Master warning, HUD flash | Preempts everything |
| CAUTION | Act soon | Chime | Once; again after 30 s if unresolved | Master caution | Preempts advisories |
| ADVISORY | Be aware | None | Once, may be batched | Caption line | Waits for a gap |
| STATUS | Requested information | None | On request only | Panel | Never |

### 9.2 Phrasing grammar

**Condition, position, range, extra, action.** Position is a clock position relative to the nose ("left eight") for threats and a bearing for navigation. Range is in miles; altitude is "low", "high" or angels. At most seven words come before the action, and the action starts with a verb.

| Condition | Spoken alert |
| --- | --- |
| Radar missile launch | "Missile, left eight, six miles. Break right, chaff." |
| IR missile, close | "Missile, right four, close. Flares, break left." |
| SAM tracking | "SAM tracking, right two, twenty miles. Descend, mask behind the ridge." |
| Fighter committing | "Bandit, nose, forty miles, high, committing." |
| Drone swarm | "Drone swarm, twelve o'clock, eight miles, low, five contacts." |
| Detection risk | "Search radar has you. Come right twenty to reduce signature." |
| Ground collision | "Pull up. Pull up." |
| Obstacle | "Tower, twelve o'clock, two miles, four hundred feet." |
| Engine fire | "Fire, left engine. Throttle off, fire switch." |
| Bingo fuel | "Bingo fuel. Home plate two four zero, one hundred twenty miles." |
| Weather | "Thunderstorm ahead, ten miles. Suggest heading three one zero." |
| Envelope | "Over G." / "Angle of attack." |
| Threat cleared | "Missile defeated." |

### 9.3 Generation path and latency

- **WARNING and CAUTION:** slot-filled templates. Fixed fragments (numbers, clock positions, threat names) are pre-synthesized audio clips stitched together, with browser speech synthesis as fallback.
- **ADVISORY and STATUS:** may use BRIEF's LLM output, never on the critical path.
- **Guardrail:** every number in LLM text is checked against the blackboard before it is spoken; a mismatch falls back to the template.
- **Latency budget:** detection to alert published 50 ms or less, PIA queueing 10 ms or less, audio start 90 ms or less, total 150 ms or less.

### 9.4 De-cluttering and workload

- **De-duplication:** the same threat and message inside its time-to-live is suppressed.
- **Coalescing:** five drones become one swarm call; two SAMs on one bearing become "Two SAMs, right two."
- **Preemption:** a WARNING cuts current speech at a word boundary, and the cut message is re-queued if still valid.
- **Workload model:** pilot load is estimated from G, active warnings, stick and throttle activity, and recent speech. Under high load, advisories are held, cautions delayed and phrases switch to a terse variant ("Missile, left eight, break right").
- **Verbosity setting:** terse, standard or instructional. Instructional adds the reason, such as "to deny its radar a clean track."
- **Acknowledge:** "copy" or the acknowledge button stops a repeating warning.

### 9.5 Audio and captions

- Web Audio panning places each tone around the pilot's head at the threat bearing (headphones recommended).
- Each threat class has its own earcon: missile fast warble, SAM pulse, terrain low whoop, fire bell.
- Every spoken alert is also printed in the alert log and the HUD caption line, for accessibility and muted play.

## 10. Natural language commands

Most spoken commands never touch an LLM: a local grammar covers the roughly 60 phrases pilots actually use and acts within 300 ms, and the LLM handles only questions and multi-step requests.

### 10.1 Pipeline

1. **Push-to-talk** on a HOTAS button or the space bar opens the microphone.
2. **Speech-to-text** runs in the browser with an aviation phrase list (angels, bingo, chaff, bandit); cloud transcription is the fallback.
3. **Fast path.** A normalizer turns "two seven zero" into 270 and "angels twenty" into 20,000 ft, then a deterministic grammar emits an intent.
4. **Slow path.** If the grammar fails or the utterance is a question, NLU sends the transcript plus a compact context (own state, top five threats, route, fuel) to the LLM, which must answer in a JSON schema.
5. **Validation.** Schema, value ranges and safety rules are checked in code. A descent below terrain clearance is refused, for example.
6. **Read-back.** PIA reads the command back in standard form ("Heading two seven zero"), then executes or waits for confirmation, per policy.
7. **Execution.** The intent becomes a directive with the pilot as source. It outranks all agent advice except ground and mid-air collision avoidance.

### 10.2 Command categories

| Category | Example utterances | Confirmation |
| --- | --- | --- |
| Flight path | "Heading two seven zero", "Climb angels twenty-five", "Speed four hundred", "Hold altitude" | Read-back only |
| Defensive | "Chaff", "Flares", "Program two", "Countermeasures auto" | None: executes immediately |
| Emissions | "Radar silent", "Radar on", "Emcon two" | Read-back only |
| Routing | "Route around the SAM", "Direct waypoint three", "Take me home" | Route preview, then "accept" |
| Questions | "Status", "Fuel state?", "What's that contact at two o'clock?", "Can the SAM see me?", "Time to bingo?" | Spoken answer |
| Systems | "Engine fire checklist", "Show engine page", "Reset master caution" | Read-back only |
| Console | "Show threat rings", "Zoom forty", "Explain that" | None |
| Alert control | "Copy", "Say again", "Quiet advisories", "Terse mode" | None |
| Protection | "Ground collision auto off" | Two-step confirmation |

### 10.3 Intent schema

```json
{
  "intent": "nav.setHeading",
  "params": { "heading_deg": 270, "turn": "shortest" },
  "confidence": 0.94,
  "requires_confirmation": false,
  "readback": "Heading two seven zero",
  "source": "grammar"
}
```

### 10.4 Reference resolution

"That contact", "the SAM" and "him" resolve to the most recently spoken, or highest-priority, entity of a matching type. Clock references ("contact at two o'clock") match tracks within 30° of that bearing; two or more matches trigger a short clarifying question.

### 10.5 Command safety rules

- A pilot command never overrides active ground or mid-air collision avoidance.
- Irreversible actions need two-step confirmation.
- A transcript below 0.7 confidence gets "Say again."
- The LLM never executes anything. Its output is an intent proposal that deterministic code validates.
- When the LLM is unreachable or rate-limited, the grammar keeps working and free-form questions get "Unable, voice queries offline."

## 11. Pilot web console

The console has three zones (the out-the-window view with HUD, the cockpit displays around it, and an Agent Ops panel that shows the agents thinking) plus an Explain mode that opens a concept visual for anything on screen.

### 11.1 Layout

- **Center:** 3D out-the-window view with the HUD overlaid.
- **Bottom row:** four multifunction displays: situation display (largest), warning receiver scope, engine page, fuel page. Each swaps by click or voice ("Show systems").
- **Left column:** standby instruments, master caution and warning, defensive systems, emissions-control level.
- **Right column, Agent Ops:** agent mesh visualizer, threat priority stack, alert log with captions, voice transcript with push-to-talk.
- **Top bar:** mission phase, clock, scenario, LLM online or offline, verbosity, pause and replay.
- **Responsive:** on a laptop the displays become tabs; a tablet gets the instructor and observer view.

&#91;embedded content: Console layout · 3 zones plus top bar\]

The Agent Ops column is what makes this console different from a game cockpit: it shows the agents' reasoning beside the instruments it drives.

### 11.2 Concept-illustrating components

| Component | Concept it teaches | What the user sees | Interaction |
| --- | --- | --- | --- |
| Agent mesh visualizer | How the agents cooperate | Live graph of the 18 agents by cluster; edges pulse as messages flow, colored by priority | Click an agent for its inputs, last outputs, rate and CPU time |
| Decision trace ("Why?") | Arbitration and the safety hierarchy | Which agents advised what for the current directive, which won and why; suppressed advice greyed out | Opens from any alert |
| Signature polar plot | Aspect-dependent radar signature | Polar plot of own signature by azimuth, with a needle for each enemy radar's viewing angle | Turn and watch needles cross the lobes |
| Detection rings and heat map | Detection range versus signature, sensor and weather | Each enemy radar's detection ring for own aircraft, resizing live; heat map of detection probability | Toggle per threat; altitude slider |
| Terrain masking profile | Line of sight and masking | Side view from an enemy radar to own aircraft over the terrain profile; the sight line turns red or green | Drag own altitude to find where masking is lost |
| Missile envelope visual | Maximum range versus no-escape zone | Arcs from each enemy fighter, no-escape zone shaded | Hover for time to escape |
| Threat priority stack | The scoring model | Ranked bars split into lethality, engagement, urgency and confidence | Click a factor for its explanation |
| Sensor fusion view | From raw observations to tracks | Raw hits per sensor as noisy colored dots, beside fused tracks with uncertainty ellipses | Switch sensors off to see degradation |
| Flight envelope diagram | Load factor versus airspeed | Live point inside the stall line, G limits and corner speed | Live |
| Energy-maneuverability plot | Specific excess power | Power contours over Mach and altitude with own point | Live |
| Fuel timeline | Bingo, joker and range | Projected fuel over time with bingo line and fuel needed to return; range ring on the map | What-if throttle slider |
| Warning receiver explainer | Emitter modes | Scope with legend and each emitter's search, track, guidance progression | Hover |
| Countermeasure effectiveness | Decoys versus seekers | Seeker cone with chaff and flare clouds and a lock-probability gauge | Replay |
| Weather cross-section | Weather effects on flight and sensors | Vertical slice along the route: clouds, icing, turbulence, sensor attenuation bands | Hover |
| Reaction timeline | Human-machine teaming latency | Per alert: detect, assess, decide, speak, pilot reacts | Debrief |

**Explain mode** puts a "?" badge on every display. A click opens a concept card with an animated version of the relevant visual and two or three plain sentences. Saying "Explain that" opens the card for the last alert.

### 11.3 Rendering stack

- 3D scene in Three.js on WebGL2, WebGPU where available, with level-of-detail terrain chunks.
- SVG for HUD and gauges (crisp at any scale), Canvas 2D for high-rate scopes, D3 for analytic plots.
- The scene targets 60 fps; instruments refresh at 30 Hz and the agent visualizer at 10 Hz to save CPU.
- Dark cockpit theme by default; colorblind-safe palette, and shape plus label always carry meaning, never color alone.

Every display and concept visual subscribes to the same bus the agents use, so a replay drives them exactly as live flight does.

## 12. Data model and message contracts

Six record types and one message envelope carry everything between the core, the agents and the console; positions use a local east-north-up frame in meters around the scenario origin, and clock positions are always relative to the nose.

```typescript
type Vec3 = [number, number, number];               // meters, ENU
type Level = 'WARNING' | 'CAUTION' | 'ADVISORY' | 'STATUS';
type Axis = 'heading' | 'altitude' | 'speed' | 'throttle' | 'emitters' | 'countermeasures' | 'route';

interface OwnState {
  tick: number; pos: Vec3; vel: Vec3; att: [number, number, number, number]; // quaternion
  mach: number; kcas: number; altFt: number; aglFt: number; aoaDeg: number; g: number;
  fuelLb: number; engines: EngineState[]; emcon: 0 | 1 | 2 | 3;
  cm: { chaff: number; flares: number; decoys: number };
}

interface Track {
  id: string; kind: 'air' | 'missile' | 'drone' | 'ground' | 'unknown';
  identity: 'friend' | 'hostile' | 'neutral' | 'unknown';
  pos: Vec3; vel: Vec3; cov: number[];                // 6x6 covariance, row-major
  quality: number; sources: string[]; lastSeenTick: number;
}

interface Threat {
  id: string; trackId: string;
  class: 'radar_missile' | 'ir_missile' | 'fighter' | 'drone' | 'swarm' | 'sam' | 'shorad' | 'gun' | 'radar';
  lethality: number; pEngage: number; tActS: number; confidence: number;
  score: number; level: Level; intent?: string; envelope?: { rMaxM: number; rNoEscapeM: number };
}

interface Advice {
  id: string; axis: Axis; value: unknown; utility: number;
  safetyRank: number;                                 // 1 = ground collision ... 9 = navigation
  source: string; evidence: string[]; ttlMs: number;
}

interface Directive { id: string; axis: Axis; value: unknown; source: string | 'pilot'; supersedes: string[]; why: string[] }

interface Alert {
  id: string; level: Level; text: string; terse: string;
  bearingDeg?: number; threatId?: string; dedupKey: string; ttlMs: number;
}

interface BusMessage<T> {
  id: string; topic: string; source: string; tick: number; snapshotVersion: number;
  priority: number; ttlMs: number; confidence: number; evidence: string[]; payload: T;
}

interface Agent {
  id: string; tier: 'R' | 'T' | 'D'; rateHz: number; budgetMs: number;
  reads: string[]; writes: string[];
  step(snapshot: Snapshot, inbox: BusMessage<unknown>[]): BusMessage<unknown>[] | Promise<BusMessage<unknown>[]>;
}
```

**Contract rules**

- An agent may publish only to topics listed in its `writes`; the bus rejects anything else, which enforces the single-writer rule.
- Every `Advice` and `Alert` must name evidence. The decision trace and the debrief are built from these links.
- A reflex agent's `step` must be synchronous and finish inside `budgetMs`; overruns are logged and three in a row demote the agent to a lower rate.

## 13. Scenarios, adversary agents, replay and debrief

Scenarios are JSON files; adversaries are agents too, but they live in the simulation core and, like the blue agents, see only what their own sensors see.

### 13.1 Scenario files

A scenario declares theater (terrain tiles and origin), weather and time of day, own aircraft (fuel, stores, start point), route, friendly assets, red forces with profiles and behavior settings, triggers (pop-up SAM, swarm launch, engine fault at a time or place), objectives, scoring weights and difficulty.

```json
{
  "id": "sam-belt-01",
  "title": "SAM belt ingress",
  "theater": { "terrain": "ridges-01", "origin": [36.2, -115.9] },
  "weather": { "clouds": [{ "baseFt": 8000, "topFt": 14000, "cover": 0.6 }], "windKt": [270, 25] },
  "own": { "fuelLb": 18000, "start": [0, 0, 6000], "headingDeg": 90 },
  "route": [[40000, 5000], [90000, -12000], [140000, 0]],
  "red": [
    { "type": "sam_long", "pos": [70000, 8000], "emcon": "silent_until_cued" },
    { "type": "fighter_gen4", "count": 2, "cap": [120000, 20000, 25000], "skill": 0.6 }
  ],
  "triggers": [{ "at": { "t": 420 }, "do": "fault", "target": "engine_left", "kind": "oil_pressure" }],
  "objectives": ["reach_wp3", "rtb_above_bingo"]
}
```

**Training ladder**

1. Familiarization: flight, weather and fuel management, no threats.
2. Low level: valley route with towers and cables; ground-collision protection demonstration.
3. SAM belt: ingress through layered SAM coverage using masking and routing.
4. Drone swarm: detect and avoid a swarm over a defended point.
5. Beyond-visual-range defense: two fighters commit and launch; missile defense.
6. Combined: SAMs, fighters, weather and an engine fault on egress with tight fuel.

### 13.2 Red-force agents

- **Fighter pilot agent.** A behavior tree with utility scoring: patrol, detect, commit, intercept, launch, support, defend, disengage on low fuel. Skill parameters set reaction time, sensor discipline, aggressiveness and preferred launch range.
- **Air-defense network agent.** Links early-warning radars to SAM sites and cues fire-control radars from early-warning tracks, so sites can stay silent until cued.
- **SAM site agent.** Silent, search, track, engage, reload; mobile sites relocate after firing.
- **Drone swarm agent.** Flocking with shared target assignment.
- **Fair difficulty.** Difficulty scales skill parameters only. Red agents never read blue ground truth.

### 13.3 Replay and debrief

- REC stores delta-encoded state at 10 Hz plus every bus message, so any moment can be rebuilt exactly.
- Replay has a timeline scrubber and three views: pilot view, truth view, and agent-belief view. Truth beside belief, showing what the agents missed or got wrong, is the main teaching tool.
- The debrief combines metrics with a short BRIEF narrative: survival, objectives, minutes inside threat envelopes, minutes detected, alert-to-reaction times, false alarms, fuel at landing, and three things to try next time.

## 14. Non-functional requirements, testing and roadmap

The system is accepted when reflex alerts land under 150 ms at the 95th percentile, the six ladder scenarios pass headless regression, and missile warnings reach 95% detection with at most one false alarm per 10 minutes.

### 14.1 Non-functional requirements

| Requirement | Target |
| --- | --- |
| Frame rate | 60 fps on a recent laptop with integrated graphics; never below 30 fps |
| Determinism | Identical replay from seed plus input log |
| Reflex alert latency | 150 ms or less, 95th percentile, event to audio start |
| Fast-path command latency | 300 ms or less, 95th percentile, final transcript to read-back start |
| LLM answer latency | 3 s or less, 95th percentile |
| Agent CPU budget | 6 ms or less per frame on average, all agents together |
| First load | 5 MB or less compressed before first flight; terrain streams afterwards |
| Browsers | Current Chrome, Edge, Firefox and Safari; voice input works best in Chromium browsers |
| Offline | Standalone mode works with no network after the first load, through a service worker |
| Accessibility | Captions, remappable controls, colorblind-safe palette, keyboard-only play |
| Privacy | Voice processed in the browser by default; no audio stored; transcripts kept in debriefs only on opt-in |

### 14.2 Testing

- **Agent unit tests** replay recorded snapshots against golden outputs.
- **Property tests** prove arbitration never violates the safety hierarchy and the bus rejects writes outside an agent's contract.
- **Scenario regression** runs the six ladder scenarios headless with a scripted pilot bot (attentive and inattentive variants) on every commit.
- **Latency harness** timestamps every message hop and charts the 95th percentile per alert class.
- **Human evaluation** compares reaction time and workload (NASA-TLX) with agents on and off.

### 14.3 Acceptance metrics

| Metric | Target |
| --- | --- |
| Missile launches inside distributed-aperture range that are announced | 95% or more |
| False missile alarms at default settings | 1 or fewer per 10 minutes |
| Ground impacts in the low-level scenario, protection on, inattentive bot | 0 |
| Fast-path intent accuracy on a 500-utterance test set | 95% or more |
| Numbers in LLM-generated speech that disagree with the blackboard | 0 (guardrail blocks them) |

### 14.4 Roadmap

Four phases, each closed by a gate; the companion Cloudflare prototype is Phase 0 and has its own implementation document.

&#91;embedded content: Roadmap · 4 phases, 4 gates\]

No phase starts until the previous gate is met; Gate 0 is the missile-launch sequence from section 5.7 running end to end in the prototype.
