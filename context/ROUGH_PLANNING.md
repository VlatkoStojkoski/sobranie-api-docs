# Rough Planning
Used for the dev(s) to create plans for what they want the project to actually be.
Check `/context/RULES.md` before modifying this file.

## General
End goal: Generate a nice TypeScipt SDK and Documentation Website for the API that sobranie.mk uses but is undocumented.
Other goals:
- SDK and Docs should be generated from OpenAPI.
- OpenAPI index file and separate files for each API method. + bundled OpenAPI file compatible with tooling.
- Get raw req/res API calls by letting the user browse and recording it.
- Add actual model (MVC) relationship data and field descriptions using LLM.
- Incrementaly improve results by adding on new recordings.

## Flows

### Recording session and output

1. Start Dev Proxy recording
2. After dev is done recording save new har file inside a folder called `har-recordings`

### Generate OpenAPI

1. Transform input folder to input for this flow
    * For each har file inside `har-recordings`, and then for each entry inside of it
        * Filter out if it's not a POST request to `https://sobranie.mk/Routing/MakePostRequest` or doesn't have `MethodName` (case-insensitive) field in req body
        * Some `MethodName` fields might have values that start with "/" before the actual name, remove that slash and keep the stuff after it
        * Change all fields in the request to CamelCase
        * Store request samples to `qt-samples/<MethodName>_request-samples.json` and response samples to `qt-samples/<MethodName>_response-samples.json`
2. Generate initial OpenAPI
    * Use quicktype to generate OpenAPI request and response schemas for all methods
    * Inside `qt-openapi` create separate schema files for all requests and responses for all methods. Of course they should be neatly organized into folders. Just not a too complex structure
    * Create index OpenAPI file called `qt-openapi/openapi.yaml` where we reference to the separate files

### Enrich OpenAPI using AI

Goals:
- Get field descriptions
- Define models (from the MVC pattern the API is obviously using in the background)
- For any fields that look like enums or references to other models