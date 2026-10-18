/** The workspace the app has open. The hosted demo has exactly one (`DEMO_PROJECT`); its path is only a key for the stores. */
export type Project = {
  name: string;
  slug: string;
  path: string;
  /** `owner/name` of a GitHub repository, when the project has one. */
  github: string | null;
};
