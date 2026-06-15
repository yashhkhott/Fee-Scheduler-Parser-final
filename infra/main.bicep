@description('Name suffix for all resources to guarantee global uniqueness')
param suffix string = uniqueString(resourceGroup().id)

@description('Azure Region to deploy resources')
param location string = resourceGroup().location

@description('Postgres DB administrator username')
param dbAdminUser string = 'dbadmin'

@description('Postgres DB administrator password')
@secure()
param dbAdminPassword string

// 1. Azure Storage Account (Blob Storage)
resource storageAccount 'Microsoft.Storage/storageAccounts@2022-09-01' = {
  name: 'store${suffix}'
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

// Storage container for raw PDFs
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2022-09-01' = {
  parent: storageAccount
  name: 'default'
}

resource pdfContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2022-09-01' = {
  parent: blobService
  name: 'fee-schedules'
  properties: {
    publicAccess: 'None'
  }
}

// 2. Azure Service Bus (Parse Queue)
resource serviceBusNamespace 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: 'sbns-${suffix}'
  location: location
  sku: {
    name: 'Basic'
    tier: 'Basic'
  }
}

resource serviceBusQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: serviceBusNamespace
  name: 'parse-jobs'
  properties: {
    maxSizeInMegabytes: 1024
    defaultMessageTimeToLive: 'PT14D' // 14 days TTL
    lockDuration: 'PT5M' // 5-minute lock duration
  }
}

// Service Bus Connection String Rule helper
resource authRule 'Microsoft.ServiceBus/namespaces/AuthorizationRules@2022-10-01-preview' = {
  parent: serviceBusNamespace
  name: 'RootManageSharedAccessKey'
  properties: {
    rights: [
      'Listen'
      'Send'
      'Manage'
    ]
  }
}

// 3. Azure Postgres Flexible Server
resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2022-12-01' = {
  name: 'pgserver-${suffix}'
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    administratorLogin: dbAdminUser
    administratorLoginPassword: dbAdminPassword
    version: '15'
    storage: {
      storageSizeGB: 32
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
  }
}

resource postgresDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2022-12-01' = {
  parent: postgresServer
  name: 'fee_schedule_db'
  properties: {
    charset: 'utf8'
    collation: 'en_US.utf8'
  }
}

// Firewall rules to allow other Azure services (like ACA) to connect
resource pgFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2022-12-01' = {
  parent: postgresServer
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// 4. Azure Container Registry (ACR)
resource acr 'Microsoft.ContainerRegistry/registries@2023-01-01-preview' = {
  name: 'acr${suffix}'
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: true
  }
}

// 5. Azure Container Apps Environment
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2021-06-01' = {
  name: 'law-${suffix}'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'insights-${suffix}'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

resource acaEnv 'Microsoft.App/managedEnvironments@2022-10-01' = {
  name: 'acaenv-${suffix}'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// 6. Outputs helper definitions
output storageName string = storageAccount.name
output serviceBusName string = serviceBusNamespace.name
output serviceBusQueueName string = serviceBusQueue.name
output acrLoginServer string = acr.properties.loginServer
output postgresHost string = postgresServer.properties.fullyQualifiedDomainName
