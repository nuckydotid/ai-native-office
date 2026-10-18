/** Runtime configuration, all from environment variables (Cloud Run friendly). */
const env = process.env;

const bool = (v: string | undefined, d = false) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export interface PipelineConfig {
  port: number;
  /** `google`: real builds and rollouts. `fake`: in-process stand-ins, for tests and local work. */
  driver: 'google' | 'fake';
  /** `google`: every `/v1/*` call carries an ID token. `none`: local development only, refused on Cloud Run. */
  auth: 'google' | 'none';
  /** This service's own address: the ID-token audience and the Pub/Sub push endpoint. */
  serviceUrl: string;
  /** Service-account emails allowed to call `/v1/*`. */
  callers: string[];
  projectId: string;
  region: string;
  /** The bucket for sources, trunk archives, build logs and job metadata. */
  bucket: string;
  firestoreDatabase: string;
  artifactRepo: string;
  stagingService: string;
  prodService: string;
  buildServiceAccount: string;
  runtimeServiceAccount: string;
  /** Where the pipeline may fetch the built sample app baseline at boot (the image carries it). */
  baselineDir: string;
  smokeScript: string;
  /** The web service's address, for job and rollout events (`/internal/v1/...`). */
  webServiceUrl: string;
  /** Whether the service serves at all. The kill switch stops new work without stopping health checks. */
  enabled: boolean;
  killSwitch: boolean;
  limits: {
    jobsPerDay: number;
    jobsPerGuestHour: number;
    maxConcurrent: number;
    scansPerDay: number;
    rolloutsPerDay: number;
    exploresPerDay: number;
    jobTimeoutSeconds: number;
    /** How many requests a rollout step sends at the service. */
    probeRequests: number;
  };
}

export function loadConfig(): PipelineConfig {
  const onCloudRun = !!env.K_SERVICE;
  const driver = env.PIPELINE_DRIVER === 'fake' ? 'fake' : 'google';
  return {
    port: Number(env.PORT ?? 8080),
    driver,
    auth: env.PIPELINE_AUTH === 'none' || (!onCloudRun && env.PIPELINE_AUTH !== 'google') ? 'none' : 'google',
    serviceUrl: (env.SERVICE_URL ?? '').replace(/\/$/, ''),
    callers: list(env.PIPELINE_CALLERS),
    projectId: env.PROJECT_ID ?? env.GOOGLE_CLOUD_PROJECT ?? '',
    region: env.REGION ?? 'asia-southeast1',
    bucket: env.PIPELINE_BUCKET ?? '',
    firestoreDatabase: env.FIRESTORE_DATABASE ?? 'pipeline',
    artifactRepo: env.ARTIFACT_REPO ?? 'northwind',
    stagingService: env.STAGING_SERVICE ?? 'northwind-portal-staging',
    prodService: env.PROD_SERVICE ?? 'northwind-portal',
    buildServiceAccount: env.BUILD_SERVICE_ACCOUNT ?? '',
    runtimeServiceAccount: env.RUNTIME_SERVICE_ACCOUNT ?? '',
    baselineDir: env.BASELINE_DIR ?? '/app/sample-app',
    smokeScript: env.SMOKE_SCRIPT ?? '/app/sample-app/smoke/smoke.mjs',
    webServiceUrl: (env.WEB_SERVICE_URL ?? '').replace(/\/$/, ''),
    enabled: bool(env.PIPELINE_ENABLED, true) && env.PIPELINE_DISABLED !== '1',
    killSwitch: bool(env.KILL_SWITCH, false),
    limits: {
      jobsPerDay: num(env.JOBS_PER_DAY, 30),
      jobsPerGuestHour: num(env.JOBS_PER_GUEST_HOUR, 6),
      maxConcurrent: num(env.MAX_CONCURRENT_JOBS, 2),
      scansPerDay: num(env.SCANS_PER_DAY, 6),
      rolloutsPerDay: num(env.ROLLOUTS_PER_DAY, 15),
      exploresPerDay: num(env.EXPLORES_PER_DAY, 5),
      jobTimeoutSeconds: num(env.JOB_TIMEOUT_SECONDS, 600),
      probeRequests: num(env.PROBE_REQUESTS, 200),
    },
  };
}
