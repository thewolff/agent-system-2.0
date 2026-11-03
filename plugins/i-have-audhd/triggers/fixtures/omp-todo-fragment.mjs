// omp-todo-fragment.mjs — a REAL OMP todo call and its result, for the trigger and Stop-hook tests.
//
// Source: an OMP seat-session transcript (~/.omp/agent/seat-sessions/<seat>/<session>.jsonl, 2026-09-17),
//   line 123 (assistant toolCall, op "done") and line 125 (its toolResult). Line 124 between
//   them is a `custom` tool_execution_start entry, left out.
// The assistant line is trimmed of usage, providerPayload, duration/ttft/completedAt and
// contextSnapshot (no thinking or signature parts were present); everything else, ids
// included, is verbatim. The toolResult line is byte-for-byte verbatim.
// After this op the list is 3 completed (phase Inspection), 1 in_progress (Persistence),
// 1 pending (Wrap-up).

export const OMP_TODO_CALL = String.raw`{"type":"message","id":"fb25f286","parentId":"17ecfdd3","timestamp":"2026-09-17T06:20:04.583Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_TaoHmFsLI654Iao8rMwxm2KE|fc_08a3feedda217c4d016aab869374d887d1a7cc490dac9c1d3a","name":"todo","arguments":{"i":"Completing scratch inventory","op":"done","list":null,"task":"Inspect seat scratch directory","phase":null,"items":null,"reason":null},"intent":"Completing scratch inventory"}],"api":"openai-codex-responses","provider":"openai-codex","model":"gpt-5.6-sol","stopReason":"toolUse","timestamp":1789626001536}}`;

export const OMP_TODO_RESULT = String.raw`{"type":"message","id":"f19c3b36","parentId":"0180ea60","timestamp":"2026-09-17T06:20:04.585Z","message":{"role":"toolResult","toolCallId":"call_TaoHmFsLI654Iao8rMwxm2KE|fc_08a3feedda217c4d016aab869374d887d1a7cc490dac9c1d3a","toolName":"todo","content":[{"type":"text","text":"Remaining items (2):\n  - Persist context-only unfinished work [in_progress] (Persistence)\n  - Run and verify wrap-up artifact [pending] (Wrap-up)\nOverall: 3/5 done, 2 open.\nActive phase 2/3 \"Persistence\" (0/1).\n  Inspection:\n    - [X] Inspect seat ledger or queue\n    - [X] Inspect repository decision logs\n    - [X] Inspect seat scratch directory\n  Persistence:\n    - [ ] Persist context-only unfinished work (in progress)\n  Wrap-up:\n    - [ ] Run and verify wrap-up artifact"}],"details":{"op":"done","phases":[{"name":"Inspection","tasks":[{"content":"Inspect seat ledger or queue","status":"completed"},{"content":"Inspect repository decision logs","status":"completed"},{"content":"Inspect seat scratch directory","status":"completed"}]},{"name":"Persistence","tasks":[{"content":"Persist context-only unfinished work","status":"in_progress"}]},{"name":"Wrap-up","tasks":[{"content":"Run and verify wrap-up artifact","status":"pending"}]}],"storage":"session","completedTasks":[{"phase":"Inspection","content":"Inspect seat scratch directory"}]},"isError":false,"timestamp":1789626004585}}`;
