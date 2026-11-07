// Executable entry point. Kept separate from server.ts so tests can import the
// app handler without starting a listener.
import { main } from "./server.js";

main();
