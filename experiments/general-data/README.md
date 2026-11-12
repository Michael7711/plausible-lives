# Stage 2 — General data structures

**Research question:** Can one small, readable format describe unrelated aspects
of a life, including things people care about that are not activities?

This is the first experiment after the foundational WorkSpec studies. It uses
fictional, hand-written data. See the [proposed research architecture](../../docs/research-architecture.md)
for how this could connect to AI and WorkSpec later.

## Run it

From the repository root, with Node.js 18 or newer:

```sh
node --test experiments/general-data/model.test.cjs
node experiments/general-data/validate.cjs experiments/general-data/examples/neighbourhood.json
node experiments/general-data/validate.cjs experiments/general-data/examples/invalid.json
```

There is nothing to install. The two examples return JSON on standard output:
the first exits **0** with no issues; the second exits **1** with five issues.
Wrong arguments, unreadable files and malformed JSON exit **2** and give a
diagnostic on standard error. None of these commands calls Ollama or WorkSpec.

## What a document contains

- **Document:** `schemaVersion` is currently the number `1`. `id` names the
  document. `entities` and `statements` are lists, which may be empty.
- **Entity:** `id` is a stable name within this document, `kind` is an open label
  such as `person`, `home` or `ecosystem`, and `label` is text for the reader.
- **Statement:** `id` names it, `subject` names an existing entity, and the
  `predicate` describes what is being said. `object` is non-blank text, a finite
  number, a boolean, or an explicit link such as `{ "ref": "market-square" }`.
  Optional `context` adds human-readable circumstances. A plain string is text
  even if it matches an entity ID.

The statement's `kind` records how to read it:

| Kind | Meaning in this experiment | Example |
| --- | --- | --- |
| `premise` | Something the author assumes in this fictional setting | The flat has no step-free access. |
| `value` | Something the subject values or wants to avoid, potentially in a context | Ari prefers to avoid the busy square when seeking quiet. |
| `option` | A possibility to investigate | Ari could live in the riverside room. |

`"market-square"` is a stable ID; the display label can change without breaking
links. IDs, entity kinds and predicates start with a lowercase ASCII letter and
use lowercase letters, digits and single hyphens between words. Entity IDs and
statement IDs are unique within their own list. An ID does not yet identify the
same thing across different documents. Statement kinds and field names are
fixed for version 1; entity kinds and predicates are open vocabulary.

Think of the two lists as Java `ArrayList<Entity>` and `ArrayList<Statement>`.
The validator builds a `Set` of entity IDs, much like a `HashSet<String>`.
It then checks statements against that set, so link targets can appear anywhere
in the entity list.

## What the examples probe

| Aspect | What the example expresses |
| --- | --- |
| Family care | Ari shares responsibility for Nell during the school term. |
| Housing and access | Two candidate homes and different access facts. |
| Belonging and social environment | Mika enjoys the square's crowds; Ari seeks quiet in a different context. Mika values the choir for belonging. |
| Spiritual life | Ari values private reflection without any assigned time or score. |
| Environment | Ari wants to protect a river habitat; Mika could volunteer. |
| Money | The choir has a zero weekly fee, represented as a number. |

The flat's explicit `false` and the choir's explicit `0` survive validation.
A missing statement means the document does not say, so it cannot be read as
false or zero. The housing options can coexist; neither is a decision and
neither has been shown feasible.

## Read the code in this order

1. Open `examples/neighbourhood.json`. Follow `market-energy` and `market-noise`
   to the same entity. Notice who is speaking and what differs in the context.
2. Open `model.cjs`. `validateDocument` is the main entry point. It returns an
   array of issues, each with a path, a code and a message. `checkFields` checks
   object shape, `registerId` checks uniqueness, and `checkReference` and
   `checkObject` check links and literal values. No function changes the input.
3. Open `validate.cjs`. It reads a file, parses JSON, passes the resulting object
   to the validator, and reports the result. File/JSON errors happen before the
   model is checked.
4. Read `model.test.cjs`. It includes valid and invalid examples, command-line
   exit checks and a deliberately contradictory example that passes shape
   validation. Try pointing `market-noise` to a missing entity in a copy and
   predict the reported path before running the CLI.

## Findings and limits

The fixtures show the same format can express several different kinds of
content without adding domain-specific fields. This is an initial example,
not evidence that the format can capture everything a person might value.
The test suite checks this version of the contract, not the quality of a
fictional person's life.

- A premise is an assumption, not verified evidence. The file does not record
  whether a stated value came from a person, an observer or an AI.
- Open predicates are easy to extend but their meanings can drift. Context is
  prose, and the fee's unit is in the predicate name. Neither is usable for
  general automated reasoning yet.
- Statements express simple links and literals. Joint decisions, exact times,
  uncertainty, changing values, conflicting accounts and nested trade-offs
  need more evidence before choosing a representation.
- An attributed value is neither a numerical preference nor automatically a
  constraint. The validator cannot decide whether any option is plausible,
  wanted, affordable or available.
- The CLI is for small, local JSON fixtures. It uses Node's ordinary JSON
  parser, so repeated keys within a JSON object are resolved by the parser
  before validation. It is not a large-batch ingestion tool.

The architecture note lists questions to take to John before choosing a
second version or starting AI generation.
