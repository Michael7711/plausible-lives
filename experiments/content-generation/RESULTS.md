# Stage 3 evaluation — 12 November 2026

**Question:** Can the local model produce valid, varied Stage 2 documents,
and does that survive larger batches? Each requested slot counts in the
denominator. Rejected content was neither repaired nor replaced automatically.

## Hardware and method

MacBook Pro M4 Pro, 48 GiB unified memory (51,539,607,552 bytes);
Ollama 0.40.15, local gpt-oss:20b, MXFP4 / llama.cpp, digest
f38aa0c53da5f8c49d08c43a99df24ff53167fe68e24664a7777288e7656fdfe.
The local tag reports 13,793,441,566 bytes on disk. The model metadata
reports a maximum context of 131,072 tokens. That is distinct from the
resident allocation: the API reported 12,743,815,986 bytes at 8,192 context
and 12,877,803,027 bytes at 16,384 (about 11.87 and 11.99 GiB).
These are Ollama model-runner snapshots, not measured peak or total system
memory, and they should not be extrapolated to maximum context. See the
[Ollama context guide](https://docs.ollama.com/context-length).
The maximum context, larger models and the remote P40 were unnecessary here.

Trials used serial requests with thinking low and temperature 0.7.
Settings and seeds are in trials/ and the saved request files; raw outputs
are archived separately. Times include client request time and local saving.
The first request included about 6.6 seconds of model loading. Seeded
sampling aids reproduction but does not guarantee identical replies.

## What happened

| Config | Slots / request | Context | Strictly valid | Wall time | Main observation |
| --- | ---: | ---: | ---: | ---: | --- |
| smoke | 1 | 8,192 | 0/1 | 16.20 s | Two references to a statement ID instead of an entity ID |
| reference-smoke | 1 | 8,192 | 1/1 | 11.25 s | Same brief and seed with an explicit reference rule |
| breadth | 2 | 8,192 | 2/6 | 63.30 s | One fenced reply; a different batch had two unexpected fields and six unresolved references |
| raw-json-check | 2 | 8,192 | 2/2 | 26.85 s | Same briefs and seed as the fenced reply; explicit no-fence instruction |
| batch-eight | 8 | 16,384 | 8/16 | 83.76 s | One batch 0/8 with 27 unresolved references; one batch 8/8 with thin documents |
| single-at-16k | 1 | 16,384 | 4/4 | 42.15 s | Four briefs from the failed large batch, now in separate requests |

For the fenced batch, a separate diagnostic removed only the outer fence
and found both inner documents Stage 2-valid. They are still failures in
the strict pipeline results. The successful raw-JSON rerun does not
establish that the prompt change generalizes. The schema also did not
prevent an unexpected root context field in the breadth run.

Both eight-slot replies stopped normally, with 2,452 and 1,916 generated
tokens out of 8,500 allowed. The first failure was therefore not an
observed token-limit cutoff. The two requests used different briefs and
seeds. Comparing 8K vs 16K trials also changes batch size and prompts,
so these observations do not identify a causal context-size effect.
The four overlapping briefs all passed individually at the same context,
generation limit, temperature and prompt. This suggests packing multiple
documents into one reply may be part of the problem. It is not a matched
multi-seed comparison: request shape and seed assignment change, only half
the failed briefs were retested, and we selected them after seeing a failure.
The single requests used more wall time per document than the successful
eight-slot batch. Test that trade-off before choosing a default at scale.

## Example review

The files in examples/ are unedited accepted output from the raw-JSON and
scale trials. The following examples passed Stage 2. They demonstrate content worth examining, not quality endorsements.

| Example | Useful content | What a human still needs to check |
| --- | --- | --- |
| Spiritual belonging | Devotion and autonomy are attributed to different people; participation, private prayer and abstention remain open. | The meditation/Sabbath setting needs cultural grounding. Passing links do not make it representative. |
| Language and memory | Cultural continuity and practical communication both matter to Mira. Recording a legend and bilingual storytelling are concrete alternatives. | Sanskrit as the household language is unexplained, and the translation-app idea assumes resources not established in the premises. |
| Dignity and public space | Two people value different experiences of the same place; reducing noise can be interpreted differently. | The relation to both people is the literal "both", not a usable link. There is no account of who could set or enforce a noise rule. |
| Companionship with an animal | Represents attachment and the animal's needs within the same model. | One option suggests the vet feeds the dog when the owner is busy without establishing that this service exists. "emma" is literal text, despite resembling an entity ID. |
| Resource sharing (breadth run) | Dignity and affordability are present alongside material options. | Many options repeat across two people. The predicates and vague context do not explain why they would choose differently. |

In total, 17 of 30 requested slots passed in 12 requests, including deliberate
reruns of earlier briefs. This pooled count is bookkeeping, not a reliability
estimate across settings. No timeout or output-limit cutoff was observed.

Five of the eight accepted documents in the scale trial fell below the
four-kind threshold, and five below the four-predicate threshold.
Only one met the prompt's nominal 7-statement minimum; five of the eight
also had fewer than five entities (slots 3, 5, 6, 7 and 8).
Exact-label repetition was zero within the accepted scale batch, but
that did not reveal repeated narrative templates or generic entities.
Check the per-document counts rather than assuming a warning-free file
is rich enough.

## What this supports, and what it doesn't

- Ollama can produce multiple structurally valid Stage 2 documents in
  one call, on unrelated briefs. Larger requests can fail as a group.
  Structural validation remains necessary even with schema mode.
- Variety scores measure vocabulary, not richness. Open predicates can
  encode the same concept in different ways, and important meaning often
  sits in context text. Literal text can also sidestep link checks.
- This is a small exploratory set with deliberately curated prompts, not
  a general model-quality estimate. It does not show reliable large-scale
  generation, realism, completeness or demographic coverage.
- An overnight run would add volume to a pipeline whose link failure and
  thinness already matter. A more informative next experiment is a
  matched comparison: fixed briefs across several seeds, one vs several
  documents per call, same context, with reviewers using the same rubric.
  Compare generated entities-first vs whole-document generation before
  deciding whether the extra requests improve yield enough to be useful.

## Questions for John

1. What would make a generated example useful: richness of circumstances,
   diversity of values, visible trade-offs, or some balance of these?
2. When should a relationship be required as an explicit entity link
   rather than allowed as prose? Would entity-first generation help without
   narrowing what can be represented?
3. Which examples should humans review for stereotypes, unstated assumptions
   and missing perspectives? How should disagreements be recorded?
4. Would a small shared vocabulary improve comparability, or erase
   distinctions we want to study? Which concepts are repeatedly conflated?
