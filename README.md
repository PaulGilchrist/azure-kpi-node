# Azure App Insights KPI & Capacity Planning Automation Service (NodeJS edition)

## Project Name – `azure-kpi`

## Current State

Azure stores many separate logs for each hosted application. These logs are brought together in Azure’s “Log Analytics” of “Application Insights” along with a powerful query engine and language named “Kusto” for parsing through the logs to reveal important information.  This query engine is also used for monitoring, alerting, and visualizing metrics.

Logging is circular with a rolling 90-day window due to the sheer size of data collected, and processing required to directly query against them.  This limits their ability to be used for longer term trend analysis such as Key Performance Indicators (KPI) or resource capacity planning.

Other limitations include each question requiring a separate query, the difficulty running a query against all applications, the lack of a query repository, and the storing of previous query results for historical reference or comparison.

## Project Solution

This service allows for storing multiple queries in a repository along with a list of applications to run against.  Both of these lists are stored in JSON configuration files hosted in Azure Storage.  The service runs all queries against all applications in parallel for very fast performance, then stores the results along with all previous results in a metrics.json file back to Auzre Storage for later consumption from the associated Angular front end browser application.  This associated browser application allows table and chart presentation of the metrics, or exporting to JSON or CSV file formats for use in other systems.

Hosting this service as an Azure Function or similar allows scheduling to automatically gather new data each month allowing for long term retaining of the queries' aggregations long past Azures 90 day logging limits.

## Future Opportunities

* UI for adding, removing, or editing applications and queries - Currently configurable through environment

## Files expected

### applications.json

```json
[
    {
        "apiKey": "azureAppInsightsApiKey",
        "applicationId": "azureAppInsightsApplicationId",
        "fullName": "descriptiveLongNameHere",
        "name": "uniqueShortNameHere",
        "roleName": "optionalAzureAppInsightsRoleName"
    },
    ...
]
```

### queries.json

```json
[
    {
        "displayName": "descriptiveLongNameHere",
        "name": "uniqueShortNameHere",
        "query": "requests | limit 50"
    },
    ...
]
```
