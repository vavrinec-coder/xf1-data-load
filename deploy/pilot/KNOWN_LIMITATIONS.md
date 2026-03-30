# Known Limitations

These are the important pilot limitations to keep in mind.

## Identity and company selection

- User identity is currently based on the email saved in `Cloud Identity`
- The active Zoho company is the most recently connected company for that user
- There is not yet a dedicated company switcher inside the add-in

## Formula behavior

- Function name is `XF1.ACC_VAL(...)`
- Department-aware function is `XF1.ACC_DEPT_VAL(...)`
- The formula expects exact Zoho account names
- The period must be `YYYY-MM`
- The third argument in `XF1.ACC_DEPT_VAL(...)` must match the selected reporting tag option exactly
- Results use business display sign, not raw ledger sign

## Data behavior

- P&L accounts return monthly movement for the selected month
- Balance sheet accounts return month-end closing balance for the selected month
- Values depend on the last successful `Sync Accounting Data`
- Department-level values depend on the reporting tag selected in the add-in
- Department-level values are currently built from tagged journals, sales invoices, expenses, and bills

## Pilot scope

- Zoho Books is the only active connector in this pilot
- The pilot is intended for a small number of internal users
- Error handling and onboarding are improved, but not yet production-grade
