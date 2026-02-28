# Rules
Describes various project rules meant for both dev(s) and AI.

# General Rules for AI
- Don't rely solely on `.md` files when a dev(s) prompts you asking something about the current project state. But you should definitely point out inconsistencies between the `.md`s you went through in your response to them.

## `/context/ROUGH_PLANNING.md`
- Meant for the dev(s) to create plans for what they want the project to actually be.
- Rules for AI:
    - Whenever a change is made to the projects and relates to something in this file, add a blockquote in the appropriate place to give the dev(s) update on their plan and how it's being carried out.
    - This is just a rough planning document and some dev or ai stuff might not be completely in sync with this project. If you see something like that then note the inconcsistency within a blockquote wherever that inconsistency appears.
    - Modify only things that are in blockquotes. Don't modify anything that's outside of the blockqotes. That's strictly for the dev(s).
    - You should also point out possible directions for how a certain plan can be carried out inside the plan.
    - Any todo items inside blockquotes are stuff the developer is requesting from the LLM. E.g. `> - [ ] Research X`. Then if a dev during a coding session commands you to finish any todo task from `ROUGH_PLANNING.md` you should answer with specific answers under their todo and mark the todo as completed.
    - If a dev commands you to change something that would be inconsistent with the `ROUGH_PLANNING.md` do that and mark the inconsistency within the file. (using blockquotes of course)