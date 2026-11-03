// The surface shares the gates' caller-bound render adapter and raw storage expansion.
// Keep one implementation: markdown/OSC8 links are render-only, never ledger body markup.
export { expandCallerHandles, linkedApi, linkTerminal } from "../../gates/src/links";
