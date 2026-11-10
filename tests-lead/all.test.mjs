/**
 * One entry point for every suite.
 *
 * `node --test` cannot be used in this environment: the file runner spawns a
 * child process and the DSH sandbox denies it (`spawn EPERM`). Importing the
 * suites into one process runs the same assertions through the in-process
 * `node:test` runner.
 *
 * Run with `node tests-lead/all.test.mjs`.
 */

import './host.test.mjs'
import './contract.test.mjs'
import './integration.test.mjs'
import './client-wire.test.mjs'
import './ima.test.mjs'
import '../tests/adapters.test.mjs'
