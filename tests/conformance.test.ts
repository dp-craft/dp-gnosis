/**
 * The conformance suite entry point: the SAME 15 cases, run against BOTH real
 * adapters. A case added here is a case every adapter must answer, which is what
 * lets `--adapter` be trusted to change ranking and performance and nothing else.
 *
 * The known-answer fake is deliberately NOT included: it ignores the query and
 * owns no corpus, so it cannot answer a retrieval-behaviour question.
 */
import { createFts5Port, createLinearScanPort, describeConformance } from './conformance.js';

describeConformance('linear-scan', createLinearScanPort);
describeConformance('fts5', createFts5Port);
