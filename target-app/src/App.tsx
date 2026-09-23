import { Navigate, Outlet, createBrowserRouter } from "react-router";
import { AuthProvider } from "./auth/AuthContext";
import { LoginPage } from "./auth/LoginPage";
import { RequireAuth, SessionExpiredPage } from "./auth/SessionPages";
import { AppShell, type RouteHandle } from "./layout/AppShell";
import { MyActivityPage, ProductRatesPage } from "./pages/ReferencePages";
import { NotFoundPage } from "./pages/StatePages";
import { AdminEnvironmentPage } from "./pages/admin/AdminEnvironmentPage";
import { AdminLayout } from "./pages/admin/AdminLayout";
import {
  AdminAuditPage,
  AdminOverviewPage,
  AdminPermissionsPage,
  AdminProductsPage,
  AdminStaffPage,
  AdminTestDataPage,
} from "./pages/admin/AdminPages";
import { AccessLogPage } from "./pages/members/AccessLogPage";
import { AccountDetailPage } from "./pages/members/AccountDetailPage";
import { MemberAccountsPage } from "./pages/members/MemberAccountsPage";
import { MemberLayout } from "./pages/members/MemberLayout";
import { MemberNotesPage } from "./pages/members/MemberNotesPage";
import { MemberOverviewPage } from "./pages/members/MemberOverviewPage";
import { MemberSearchPage } from "./pages/members/MemberSearchPage";
import { ConfirmationPage } from "./pages/opening/ConfirmationPage";
import { OpenAccountLauncherPage } from "./pages/opening/OpenAccountLauncherPage";
import { OpenSubAccountPage } from "./pages/opening/OpenSubAccountPage";
import { ReviewPage } from "./pages/opening/ReviewPage";
import { useMemberQuery } from "./pages/queries";

function Root() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}

function MemberCrumb({ memberNumber }: { memberNumber: string }) {
  const q = useMemberQuery(memberNumber);
  return <>{q.data ? q.data.member.display_name : memberNumber}</>;
}

const crumb = (fn: RouteHandle["crumb"]): RouteHandle => ({ crumb: fn });

export const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { path: "/login", element: <LoginPage /> },
      { path: "/session-expired", element: <SessionExpiredPage /> },
      {
        path: "/",
        element: (
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        ),
        children: [
          { index: true, element: <Navigate to="/members" replace /> },
          {
            path: "members",
            handle: crumb(() => "Members"),
            children: [
              { index: true, element: <MemberSearchPage /> },
              {
                path: ":memberNumber",
                element: <MemberLayout />,
                handle: crumb((p) => <MemberCrumb memberNumber={p.memberNumber ?? ""} />),
                children: [
                  { index: true, element: <MemberOverviewPage /> },
                  {
                    path: "accounts",
                    handle: crumb(() => "Accounts"),
                    children: [
                      { index: true, element: <MemberAccountsPage /> },
                      {
                        path: "new",
                        handle: crumb(() => "Open sub-account"),
                        children: [
                          { index: true, element: <OpenSubAccountPage /> },
                          { path: "review", element: <ReviewPage />, handle: crumb(() => "Review") },
                          { path: "confirmation/:confirmation", element: <ConfirmationPage />, handle: crumb(() => "Confirmation") },
                        ],
                      },
                      { path: ":accountNumber", element: <AccountDetailPage />, handle: crumb((p) => (p.accountNumber ?? "").toUpperCase()) },
                    ],
                  },
                  { path: "notes", element: <MemberNotesPage />, handle: crumb(() => "Notes") },
                  { path: "access-log", element: <AccessLogPage />, handle: crumb(() => "Access log") },
                ],
              },
            ],
          },
          { path: "open-account", element: <OpenAccountLauncherPage />, handle: crumb(() => "Open sub-account") },
          { path: "products", element: <ProductRatesPage />, handle: crumb(() => "Product rates") },
          { path: "activity", element: <MyActivityPage />, handle: crumb(() => "My activity") },
          {
            path: "admin",
            element: <AdminLayout />,
            handle: crumb(() => "Administration"),
            children: [
              { index: true, element: <AdminOverviewPage /> },
              { path: "environment", element: <AdminEnvironmentPage />, handle: crumb(() => "Environment controls") },
              { path: "staff", element: <AdminStaffPage />, handle: crumb(() => "Staff & sessions") },
              { path: "permissions", element: <AdminPermissionsPage />, handle: crumb(() => "Roles & permissions") },
              { path: "products", element: <AdminProductsPage />, handle: crumb(() => "Products") },
              { path: "audit", element: <AdminAuditPage />, handle: crumb(() => "Audit log") },
              { path: "test-data", element: <AdminTestDataPage />, handle: crumb(() => "Test data") },
            ],
          },
          { path: "*", element: <NotFoundPage />, handle: crumb(() => "Page not found") },
        ],
      },
    ],
  },
]);
