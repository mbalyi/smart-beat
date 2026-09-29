/** Generated before every build by `scripts/generate-licenses.mjs`. */
export const LICENSES_URL = "/third-party-licenses.txt";

export async function fetchLicenses(): Promise<string> {
  const response = await fetch(LICENSES_URL);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}
