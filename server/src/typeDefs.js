// GraphQL schema and constants shared by the full (Docker) server and lite mode.
export const typeDefs = /* GraphQL */ `
  enum Range { LAST_HOUR LAST_24H LAST_7D LAST_30D }
  enum Role { viewer analyst admin }
  enum AlertCondition { above below anomaly }
  enum AlertChannel { log slack email webhook }

  type User { id: ID! email: String! role: Role! tenantId: ID! }

  type Kpis {
    pageviews: Int!
    visitors: Int!
    sessions: Int!
    bounceRate: Float!
    pagesPerSession: Float!
    conversions: Int!
    conversionRate: Float!
  }
  type Overview { current: Kpis! previous: Kpis! }

  type Point { t: String! pageviews: Int! visitors: Int! }
  type MinutePoint { minute: String! pageviews: Int! }
  type PageCount { path: String! views: Int! }
  type Realtime {
    activeVisitors: Int!
    activeSessions: Int!
    pageviewsLastMinute: Int!
    perMinute: [MinutePoint!]!
    activePages: [PageCount!]!
  }

  type PageStat { path: String! views: Int! visitors: Int! }
  type Referrer { source: String! sessions: Int! }

  type JourneyNode { id: String! views: Int! }
  type JourneyLink { source: String! target: String! weight: Int! }
  type JourneyGraph { nodes: [JourneyNode!]! links: [JourneyLink!]! }

  type DropOff { path: String! views: Int! exits: Int! exitRate: Float! }
  type FunnelStep { step: String! sessions: Int! conversionRate: Float! dropOffRate: Float! }
  type Catalog { pages: [String!]! goals: [String!]! }

  type AlertRule {
    id: ID!
    name: String!
    metric: String!
    condition: AlertCondition!
    threshold: Float!
    channel: AlertChannel!
    target: String
    cooldownMinutes: Int!
    enabled: Boolean!
  }
  type Alert { id: ID! ruleName: String! message: String! value: Float triggeredAt: String! }

  input AlertRuleInput {
    name: String!
    condition: AlertCondition!
    threshold: Float!
    channel: AlertChannel!
    target: String
    cooldownMinutes: Int = 15
  }

  type Query {
    me: User!
    overview(range: Range!): Overview!
    realtime: Realtime!
    timeseries(range: Range!): [Point!]!
    topPages(range: Range!, limit: Int = 10): [PageStat!]!
    topReferrers(range: Range!, limit: Int = 8): [Referrer!]!
    journey(range: Range!, limit: Int = 30): JourneyGraph!
    dropOffs(range: Range!, limit: Int = 8): [DropOff!]!
    funnel(range: Range!, steps: [String!]!): [FunnelStep!]!
    catalog: Catalog!
    alertRules: [AlertRule!]!
    alerts(limit: Int = 50): [Alert!]!
    dashboard: [String!]!
  }

  type Mutation {
    createAlertRule(input: AlertRuleInput!): AlertRule!
    setAlertRuleEnabled(id: ID!, enabled: Boolean!): AlertRule!
    deleteAlertRule(id: ID!): Boolean!
    saveDashboard(widgets: [String!]!): [String!]!
  }
`;

const HOUR = 3600_000;
export const RANGES = {
  LAST_HOUR: { ms: HOUR, bucket: 'minute' },
  LAST_24H: { ms: 24 * HOUR, bucket: 'hour' },
  LAST_7D: { ms: 7 * 24 * HOUR, bucket: 'hour' },
  LAST_30D: { ms: 30 * 24 * HOUR, bucket: 'day' },
};
export const DEFAULT_WIDGETS = ['kpis', 'realtime', 'traffic', 'journey', 'funnel', 'topPages', 'referrers', 'dropOffs'];
