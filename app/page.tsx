import { redirect } from "next/navigation";

// The composer is the app. The grid is where leads are claimed for it.
//
// Except when Supabase lands here carrying a failure. It redirects to the
// project's Site URL whenever the requested redirect is not on the allowlist,
// and on some auth errors regardless — so this route is a real destination for
// a rejected sign-in, not only for someone typing the bare domain. Redirecting
// straight to /leads would swallow the reason and show an empty login page.
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  const first = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;

  const description = first(params.error_description) ?? first(params.error);

  if (description) {
    redirect(`/login?error=${encodeURIComponent(description)}`);
  }

  redirect("/write");
}
