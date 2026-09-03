"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Self-service signup is disabled: accounts are provisioned in the LDAP
// directory. Redirect to the login page.
export default function SignupPage() {
    const router = useRouter();
    useEffect(() => {
        router.replace("/login");
    }, [router]);
    return null;
}
