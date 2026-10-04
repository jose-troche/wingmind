# Decision trace

When agents disagree on one control axis, ORCH resolves it by the **safety hierarchy** first and utility second: ground collision, mid-air, missile defense, envelope, engine emergency, threat avoidance, fuel, weather, navigation.

Example: SIG wants your nose on the enemy radar for the smallest signature, while MAWS wants a beam turn against an inbound missile. Missile defense ranks higher, so SIG's advice is suppressed and the reason is logged.

- The winner is listed first.
- Suppressed advice is struck through.
- NAV's terrain check and ENV's G cap shape the final directive.
