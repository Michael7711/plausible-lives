# Plausible Lives: proposed research architecture

This is a working proposal for discussion with John. The aim is to represent
things people might value across many domains, then investigate which possible
lives satisfy stated assumptions and constraints. The unit of research is a
model that can be examined and revised. No particular application or life
domain sets the boundaries.

The existing parcel and Ollama experiments are foundational WorkSpec work.
The parcel experiment separates initial state, Changes and constraints. The
repair experiment adds a boundary: the model proposes restricted JSON, trusted
code translates it, and WorkSpec checks the result against a fixed rule. Stage 2
reuses that separation of data, interpretation and checks without importing
the parcel-specific code.

| Research stage | Input → output | What would count as progress |
| --- | --- | --- |
| **2. General data structures** (implemented here) | Hand-written fictional examples → versioned entity/statement JSON → structure and reference report | Several unrelated domains can use the same format; deliberate shape and link errors are detected. Record cases the format cannot express. |
| **3. AI-generated structured content** (proposed) | A versioned format and bounded prompts → candidate JSON plus prompt/model provenance and validation results | Start small with human-reviewed examples. Distinguish parse success, valid references, duplication and meaningful coverage. Only then test generating larger batches; keep counts for rejected as well as accepted candidates. |
| **4. WorkSpec constraint integration** (proposed) | Validated data and an explicit mapping for one slice → WorkSpec starting state, Changes, optional Generator, and separately versioned rules → CLI diagnostics and state evidence | Demonstrate one mapped scenario with a known pass and a known failure. Record the mapping, unsupported data, seed and run horizon. Review generated rules separately before considering them for the baseline. |
| **5. Exploring and comparing plausible lives** (proposed) | Alternative scenarios with recorded assumptions and rule versions → comparisons of outcomes, trade-offs and unresolved questions | Compare alternatives under shared assumptions where possible. Trace differences to a recorded option or changed condition, and label cases where the cause is unknown. Avoid a universal score or an assumed best life. |

The numbering treats the earlier WorkSpec studies as the foundation and the
current data experiment as Stage 2. The last three rows are design directions,
not implemented interfaces or commitments.

## Boundaries between the stages

- **Structure first.** Passing validation means that the document has the
  expected shape and its references resolve. It says nothing about truth,
  usefulness, completeness or internal consistency. A human can read the same
  JSON that a later tool consumes.
- **AI proposes data.** Save the raw output and the accepted candidate
  separately. Start with generated entities and statements; later a bounded
  repair can propose a small edit to a candidate. Never run arbitrary code
  from model output.
- **Translate a slice, not a whole person.** A later adapter could map two
  housing options and an access condition to WorkSpec while keeping belonging,
  spiritual meaning or ecological values in the source record until we know
  how to represent them faithfully. Starting state describes the world;
  Changes describe authored effects; an optional seeded Generator supplies
  simulated updates. Constraints inspect what actually happened in the run.
  Run the CLI on each scenario and retain its report. A snapshot is evidence
  about state, not evidence that every constraint passed.
- **Keep scenario repair and rule research separate.** Evaluate repairs
  against a fixed, human-reviewed baseline. For AI-authored or modified rules,
  use a separate proposal track: represent a small rule as structured data,
  review its meaning and scope, and check it against known positives,
  negatives and boundary cases using trusted interpretation. Report changes
  to accepted scenarios against the original rule set. A weaker rule is a
  change in assumptions, not evidence that a scenario was repaired.
- **Compare only what the evidence supports.** A life that passes tested
  rules is plausible only under those rules and the stated assumptions.
  Different outcomes may reflect circumstances, incomplete information or
  other people's actions. Call a difference a possible choice only when
  the alternatives and ability to choose are supported in the model.

## Questions to discuss with John

1. **What counts as a value?** Do needs, commitments, aversions and collective
   obligations belong together? How should we represent something meaningful
   only in a relationship or when combined with other things?
2. **Whose account?** Should the next format distinguish a person's own
   statement, someone else's interpretation and AI-generated assumptions?
   What evidence and permission would be needed before modelling real lives?
3. **What deserves structure first?** Time, units, uncertainty, context and
   provenance all matter. Which examples break the current format enough to
   justify adding fields? Which can remain human-readable?
4. **What makes a rule hard?** When does access, care or affordability become a
   feasibility constraint, and whose authority determines that? Which slice
   would be a fair first mapping into WorkSpec?
5. **How do we judge generated content and comparisons?** Is progress
   breadth, semantic coherence, useful differences, or something else? What
   would let us distinguish a feasible choice from a difference imposed by
   resources, other people or the setup of the experiment?
