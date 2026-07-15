export async function updateProfile(input: { displayName: string }) {
  "use server";
  return { displayName: input.displayName };
}
