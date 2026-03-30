# Colleague Onboarding

Use this for the first pilot test.

## Before you start

- Use Excel desktop
- Make sure the `XF1 Excel Addin` is assigned to you in Microsoft 365
- Have your own Zoho Books login ready

## First-time setup

1. Open Excel and open the `XF1 Panel`.
2. In `Cloud Identity`, enter your work name and work email.
3. Click `Save Identity`.
4. Click `Connect Zoho`.
5. In the browser, sign in to your Zoho Books account and approve access.
6. Return to Excel.
7. If you want to use `XF1.ACC_DEPT_VAL(...)`, choose the reporting tag that should drive dimensional lookups and click `Save Dimension Tag`.
8. Click `Sync Accounting Data`.

## First smoke test

Open:

- `deploy/pilot/XF1-Pilot-Test-Workbook.xlsx`

Then confirm:

- the `Cloud Zoho` box shows your connected company
- the `Dimension Tag` box shows the selected reporting tag if you plan to use `XF1.ACC_DEPT_VAL(...)`
- the `Sync Accounting Data` action completes successfully
- the example `XF1.ACC_VAL(...)` cells return numbers
- if you use reporting tags, `XF1.ACC_DEPT_VAL(...)` returns numbers for tagged journals, sales invoices, expenses, and bills

## If something looks wrong

- Reopen the `XF1 Panel`
- Confirm `Cloud Identity` email is correct
- Click `Connect Zoho` again if needed
- Confirm the correct `Dimension Tag` is selected if department-style lookups are expected
- Click `Sync Accounting Data` again

## Important

- The account names in formulas must match the Zoho Chart of Accounts exactly
- The period must be in `YYYY-MM` format
- Department names in `XF1.ACC_DEPT_VAL(...)` must match Zoho reporting tag options exactly
- Display signs are business-friendly, not raw ledger signs
