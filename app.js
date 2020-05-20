'use strict';

// https://docs.microsoft.com/en-us/azure/storage/blobs/storage-quickstart-blobs-nodejs

const args = require('minimist')(process.argv.slice(2)); // Get arguments by name rather than by index
const axios = require('axios')
const { BlobServiceClient } = require('@azure/storage-blob');
const https = require('https');
const chalk = require('chalk'); // Add color to the console
const uuidv1 = require('uuid/v1');

const main = async () => {
    console.log('KPI data collection service starting');
    const azureStorageConnectionString = args['azureStorageConnectionString'] || process.env.AZURE_STORAGE_CONNECTION_STRING;
    const blobServiceClient = await BlobServiceClient.fromConnectionString(azureStorageConnectionString);
    const containerClient = await blobServiceClient.getContainerClient('kpi');
    // Run these in parallel (no await)
    const promisses = [];
    promisses.push(getApplications(containerClient));
    promisses.push(getMetrics(containerClient));
    promisses.push(getQueries(containerClient));
    return Promise.all(promisses)
        .then((results) => {
            const applications = results[0];
            const metrics = results[1];
            const queries = results[2];
            return processMetrics(applications, containerClient, metrics, queries);
        })
        .catch(handleError);
}

const addMonth = async (applications, app, date, queries) => {
    // Get data for the full month preceeding the date passed in
    // ex: 5/15/2020 passed means get the full month od April (May data collection is not completed yet)
    const fromDate = new Date(date.getFullYear(), date.getMonth() - 1, 1);
    const toDate = new Date(date.getFullYear(), date.getMonth(), 1);
    const month = {
        // January is 0 not 1
        date: `${toDate.getMonth() + 1}/1/${toDate.getFullYear()}`
    };
    app.months.push(month);
    const requestArray = [];
    const connection = getKustoConnection(applications, app.name);
    queries.forEach(query => requestArray.push(getKustoResult(connection, fromDate, toDate, query.query)));
    return Promise.all(requestArray)
        .then((responses) => {
            for (let i = 0; i < queries.length; i++) {
                month[queries[i].name] = Number(responses[i]);
            }
        })
        .catch(handleError);
}

const createNewApp = (app, metrics) => {
    // Create new app
    const newApp = {
        fullName: app.fullName,
        months: [],
        name: app.name
    };
    metrics.applications.push(newApp);
    // Keep applications in fullName sort order
    utilities.sort(metrics.applications, 'fullName');
    return newApp;
}

const getApplications = async (containerClient) => {
    // Get Applications
    console.log('Getting applicaiton list from Azure Storage');
    const blockBlobClient = containerClient.getBlockBlobClient("applications.json");
    const downloadBlockBlobResponse = await blockBlobClient.download(0); // Get blob content from position 0 to the end
    return JSON.parse(await streamToString(downloadBlockBlobResponse.readableStreamBody)); // Browser would use blobBody rather than readableStreamBody
}

const getKustoConnection = (applications, name) => {
    const connection = {
        apiKey: null,
        applicationId: null,
        options: null,
        roleName: null,
        url: null
    };
    const appDetails = applications.find((a) => a.name === name);
    if (appDetails !== undefined) {
        connection.apiKey = appDetails.apiKey;
        connection.applicationId = appDetails.applicationId;
        connection.options = {
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': connection.apiKey
            }
        };
        connection.roleName = appDetails.roleName;
        connection.url = `https://api.applicationinsights.io/v1/apps/${connection.applicationId}/query`;
    }
    return connection;
}

const getKustoResult = async (kustoConnection, fromDate, toDate, query) => {
    // Query Azure App Insights
    query = query
        // January is 0 not 1
        .replace('<FromDateGoesHere>', `${fromDate.getMonth() + 1}/${fromDate.getDate()}/${fromDate.getFullYear()}`)
        .replace('<ToDateGoesHere>', `${toDate.getMonth() + 1}/${fromDate.getDate()}/${toDate.getFullYear()}`)
        .replace('<RoleNameGoesHere>', kustoConnection.roleName);
    return axios.request({
        data: { query },            
        headers: kustoConnection.options.headers,
        httpsAgent: new https.Agent({
            keepAlive: true,
            rejectUnauthorized: false // (NOTE: this will disable client verification)
        }),
        method: 'post',
        url: kustoConnection.url
    }).then((response) => {
        return response.data.tables[0].rows[0]; // Only one row will come back
    })
    .catch(handleError);
}

const getQueries = async (containerClient) => {
    // Get Queries
    console.log('Getting query list from Azure Storage');
    const blockBlobClient = containerClient.getBlockBlobClient("queries.json");
    const downloadBlockBlobResponse = await blockBlobClient.download(0); // Get blob content from position 0 to the end
    return JSON.parse(await streamToString(downloadBlockBlobResponse.readableStreamBody)); // Browser would use blobBody rather than readableStreamBody
}

const getMetrics = async (containerClient) => {
    // Get Metrics
    console.log('Getting metrics data from Azure Storage');
    const blockBlobClient = containerClient.getBlockBlobClient("metrics.json");
    const downloadBlockBlobResponse = await blockBlobClient.download(0); // Get blob content from position 0 to the end
    return JSON.parse(await streamToString(downloadBlockBlobResponse.readableStreamBody)); // Browser would use blobBody rather than readableStreamBody
}

const handleError = (error) => {
    // In the future, we may send the server to some remote logging infrastructure
    console.error(error);
    return observableThrowError(error || 'Server error');
}

const processMetrics = async (applications, containerClient, metrics, queries) => {
    console.log('Processing metrics');
    // Determine the last month of data collected
    const today = new Date();
    const firstDayOfCurrentMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    let mostRecentDate = new Date('1/1/2020');
    metrics.applications.forEach(app =>
        app.months.forEach(month => {
            const metricsDate = new Date(month.date);
            if (metricsDate > mostRecentDate) {
                mostRecentDate = metricsDate;
            }
        })
    );
    // Determine if any new applications were added to the environment
    let metricsDirty = false;
    const promisses = [];
    applications.forEach(app => {
        // Get matching app from state
        let metricsApp = metrics.applications.find(a => a.name === app.name);
        if (metricsApp === undefined) {
            metricsApp = createNewApp(app, metrics);
            // Try and get last 2 months of data
            metricsDirty = true;
            promisses.push(addMonth(applications, metricsApp, new Date(mostRecentDate.getFullYear(), mostRecentDate.getMonth() - 1, mostRecentDate.getDay()), queries));
            promisses.push(addMonth(applications, metricsApp, mostRecentDate, queries));
        }
        // Determine if it is time to get the next month's of data
        // Date will be first of month when full month was collected (ex: 1/1/2020 means all of January)
        if (true) {
            // if (mostRecentDate < firstDayOfCurrentMonth) {
            metricsDirty = true;
            promisses.push(addMonth(applications, metricsApp, firstDayOfCurrentMonth, queries));
        }
    });
    await Promise.all(promisses)
        .then((results) => {
            if(metricsDirty) {
                return saveMetrics(containerClient, metrics);
            } else {
                console.log('Metrics are already up-to-date.  No updates needed')
            }
        })
        .catch(handleError);
}

const saveMetrics = async (containerClient, metrics) => {
    console.log("Saving updated metrics");
    const metricsString = JSON.stringify(metrics);
    const blockBlobClient = containerClient.getBlockBlobClient("metrics2.json");
    return blockBlobClient.upload(metricsString, metricsString.length);
}

const streamToString = async (readableStream) => {
    // A helper function used to read a Node.js readable stream into a string
    return new Promise((resolve, reject) => {
        const chunks = [];
        readableStream.on("data", (data) => {
            chunks.push(data.toString());
        });
        readableStream.on("end", () => {
            resolve(chunks.join(""));
        });
        readableStream.on("error", reject);
    });
}

main().then(() => console.log('Done')).catch((ex) => console.log(ex.message));
