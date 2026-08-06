import { redirect } from "next/navigation";

// The grid is the app. Everything else is a detour from it.
export default function Home() {
  redirect("/leads");
}
