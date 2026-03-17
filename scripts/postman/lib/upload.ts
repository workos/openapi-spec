import type { PostmanCollection } from "./types.js";

export async function uploadCollection(
  collection: PostmanCollection,
  collectionUid: string,
  apiKey: string
): Promise<void> {
  const url = `https://api.getpostman.com/collections/${collectionUid}`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "X-Api-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ collection }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Postman API upload failed (${response.status}): ${body}`
    );
  }

  const result = await response.json();
  console.log("Upload successful:", JSON.stringify(result, null, 2));
}
