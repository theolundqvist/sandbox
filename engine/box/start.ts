import { prepareBox } from "./index";

/**
 * The sandbox's probe, started when the server's first import evaluates, so it runs while the server's other modules load and the world's files are set up.
 * Only the server imports this; tools and tests that use the sandbox start no probe by loading it.
 */
export const boxPrepared = prepareBox();
