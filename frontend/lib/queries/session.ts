import { useQuery } from "@tanstack/react-query";
import { register, SessionData } from "../session";

export const useGetSession = () => {
  return useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      const session = localStorage.getItem("session");
      if (!session) {
        const anonymousSession = await register({ type: "anonymous" });
        localStorage.setItem("session", JSON.stringify(anonymousSession));
        return anonymousSession;
      }
      return JSON.parse(session) as SessionData;
    },
  });
};
