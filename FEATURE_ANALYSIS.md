# True Path CRM — Feature Analysis
**Source:** International Rx CRM (`crm.internationalrx.com`)  
**Reviewed:** 2026-05-14  
**Stack:** PHP 8.2, CodeIgniter, Bootstrap + Tailwind CSS, MySQL

---

## Overview

This is a heavily customized Perfex CRM instance built for a pharmacy benefit management / specialty pharmacy operation. It combines standard CRM functions (leads, clients, tasks, invoices) with domain-specific modules for drug batch processing, rebate tracking, refill management, and UBA/Monarch integrations.

---

## Core CRM Modules

### 1. Dashboard
- Quick Statistics panel (4–6 stat cards)
- Invoice status summary (Draft / Not Sent / Unpaid / Partially Paid / Overdue / Paid)
- Estimate status summary (Draft / Not Sent / Sent / Expired / Declined / Accepted)
- Proposal status summary (Draft / Sent / Open / Revised / Declined / Accepted)
- Recent activity / news feed
- Task notifications and reminders
- New orders today / new clients today counters
- Desktop push notifications

### 2. Leads
- **List view** + **Kanban board** (switchable)
- Fields: #, Name, Company, Email, Phone, Value, Tags, Assigned To, Status, Source, Last Contact, Created
- Import from CSV
- Lead status management (custom statuses with color + order)
- Lead source tracking
- Tag system (hundreds of existing tags)
- Convert lead to client

### 3. Clients
- Fields: #, Broker, Company, Primary Contact, Primary Email, Phone, Active, Groups, Date Created, Account Coordinator
- Client groups
- Mass delete
- Exclude inactive filter
- Linked to broker, invoices, contracts, tasks, subscriptions

### 4. Tasks
- Fields: #, Color, Name, Status, Start Date, Due Date, Assigned To, Tags, Priority
- Built-in time tracking / timers (start/stop)
- Task checklists
- Task comments / activity
- Kanban and list view
- Onboarding task workflows
- Recurring tasks

### 5. Projects
- Project management linked to clients
- Task boards per project
- Billable hours tracking
- Linked to invoices and subscriptions

### 6. Calendar
- Month/week/day views
- Event creation with date/time
- Staff-level calendar visibility

### 7. Staff
- Member profiles
- Departments
- Timesheets (personal + all-staff view)
- Role-based permissions (staff / admin)
- Workgroup assignments

### 8. Tickets (Support)
- Fields: #, Subject, Tags, Department, Service, Contact, Status, Priority, Last Reply, Created, Assigned To
- Predefined replies
- Ticket services configuration
- Ticket priorities (1, 2, 3)
- Ticket statuses (custom)
- Departments configuration

### 9. Knowledge Base
- Articles with categories
- Multi-language support

---

## Financial Modules

### 10. Invoices
- Fields: Invoice #, Amount, Total Tax, Year, Date, Company, Project, Tags, Due Date, Status
- Statuses: Draft, Not Sent, Unpaid, Partially Paid, Overdue, Paid
- Line items with tax
- PDF generation / bulk PDF export
- Payment recording
- Linked to credit notes

### 11. Estimates
- Statuses: Draft, Not Sent, Sent, Expired, Declined, Accepted
- Convert estimate to invoice
- Client-facing estimate approval

### 12. Proposals
- Statuses: Draft, Sent, Open, Revised, Declined, Accepted
- Rich text editor (TinyMCE)

### 13. Credit Notes
- Linked to invoices
- Partial credit application

### 14. Contracts
- Contract types (configurable)
- Status tracking
- Document signing workflow

### 15. Subscriptions
- Fields: #, Subscription Name, Customer, Project, Status, Next Billing Cycle, Date Subscribed, Last Sent
- Recurring billing management

### 16. Payments
- Fields: Payment #, Invoice #, Payment Mode, Transaction ID, Company, Amount, Date
- Payment modes configuration

### 17. Expenses
- Categorized expenses
- Linked to projects or clients

---

## Domain-Specific Modules (Pharmacy/Healthcare)

### 18. Batch (Drug Order Processing)
Primary batch processing for fulfilled medication orders.

**Fields:**
- Customer ID, Transaction ID, Customer Name
- Drug Name, Vendor, Strength
- Unit Quantity, Vendor Quantity
- Unit Price, Unit Cost
- Transaction Price, Transaction Cost
- Shipping Method
- Status
- Transaction Date
- Document/Patient ID
- Vendor Day Supply

**Error tracking sub-table:**
- Customer ID, Name, Status, Transaction ID, Vendor, Order ID, Error Message

### 19. Temp Batch (Staging/Preview)
Pre-import staging area for batch orders before committing to Batch.

**Fields:**
- Customer Name, Drug, Vendor, Day Supply
- Price, Cost, Unit Type
- Unit Quantity, Vendor Quantity
- Unit Price, Unit Cost
- Shipping Method
- Date Prescribed, Number of Refills, Is Refill
- Override flag (manual price/cost override)
- Action (approve/reject per row)

**Error sub-table:** same as Batch

### 20. Companies
Pharmacy company/employer group records.

**Fields:** #, Name, Phone, Address, City, State, Zip Code, Creation Date

Sub-feature: **Import Company Pricing** (CSV upload for company-specific drug pricing)

### 21. Brokers
Insurance broker / benefit consultant records.

**Fields:** #, Name, Status, Address, Email  
Sub-feature: **Support Numbers** (broker-specific support line management)

### 22. Products (Drug Catalog)
**Fields:** drug/product catalog — name, unit, pricing  
Sub-feature: **Import Products** (CSV upload)

### 23. Rebates
**Import CSV fields:**
- Order Status
- Primary Member ID
- Dependent Member ID
- Product ID
- Order #
- Supply Amount
- Rebate Amount
- Rebate Total
- Reason

### 24. Refills
**Import CSV fields:**
- Order ID
- Next Fill Date
- Refill / Refill Days
- Product
- Patient ID

### 25. Transactions
**Import CSV fields:**
- Customer ID
- Transaction Number
- Drug, Drug Vendor, Drug Day Supply
- Date Ordered, Date Prescribed
- Number of Refills
- Tracking Number
- Vendor Order ID, Order Number
- UBA Order ID, Monarch Order ID
- UBA Status, Monarch Status
- Amount, Status
- Submitted By
- Complete flag
- Refund flag

### 26. Workgroups
Staff grouping for routing / assignment purposes.

**Fields:** Workgroup Name, Members

### 27. SMS Landing Page
Bi-lingual SMS message templates for patient outreach.

**Fields:** English Text, Spanish Text

### 28. Address Verification
Patient address verification with reminder scheduling.

**Logic:** If before 2PM → reminder date = today; if after 2PM → reminder date = tomorrow + 1  
**Fields:** Reminder Date, Description

### 29. Escalations
Case escalation tracking (custom module).

### 30. Reminders / Onboarding Reminders
- Fields: Related To, Description, Date, Remind (staff), Is Notified, Created By
- Separate onboarding reminder workflow

---

## Utilities & Admin

### 31. Import Hub
All CSV import tools in one area:
- Import Company Pricing
- Import Files
- Import Interactions
- Import Notes
- Import Products
- Import Rebates
- Import Refills
- Import Todos
- Import Transactions
- Import UBA Patient GUIDs

### 32. Activity Log
Full audit trail of all system actions.

### 33. Bulk PDF Exporter
Export invoices/contracts as batch PDFs.

### 34. Calendar
Global calendar with event management.

### 35. Media Library
Central file/media management.

### 36. Pipe Log
Email-to-ticket pipe logging.

### 37. Backup
Database/file backup utility.

### 38. Exports
Data export (CSV/Excel) for all major entities.

### 39. GDPR
Data privacy / deletion tools.

### 40. Modules
Custom module installer/manager.

### 41. Custom Fields
Custom fields for any entity (leads, clients, etc.).

### 42. Email Templates
Configurable email templates.

### 43. Currencies, Taxes, Payment Modes
Financial configuration.

### 44. Menu Setup
Main menu and setup menu customization.

### 45. Announcements
Staff-facing announcement board.

### 46. Todo
Personal to-do list per staff member.

---

## Tag System
Hundreds of tags used across Leads, Tasks, Clients. Key categories observed:
- **Attempt tracking:** Attempt #1–#16 (contact attempt logging)
- **Medication-specific:** MO Ozempic, MO Jardiance, MO Mounjaro, MO Eliquis, etc.
- **Programs:** 340B, UBA, UBA V2, UBA340B, Compounding Program
- **Delay/Hold reasons:** Approved Delay - Dr Appt, HOLD, Rx Delay bc Dr Visit
- **Language flags:** Spanish, Vietnamese, Filipino (Tagalog) Speaker, Hard of Hearing
- **Pharmacy routing:** Cypress Pharmacy, Insight Special Pharm, DART
- **Status flags:** VIP, DUPLICATE PROFILE, HANDLE WITH CARE, URGENT

---

## Integrations (Identified)
- **UBA (United Benefit Advisors):** Order IDs, patient GUIDs, status sync
- **Monarch:** Order tracking status
- **TinyMCE:** Rich text for proposals/KB
- **Google Picker:** File attachment via Google Drive
- **DataTables:** All grid views (Excel/CSV/PDF export built in)
- **SMS Gateway:** Patient outreach via SMS landing page
- **Telehealth:** Appointment scheduling workflow (referenced in tags)
- **Rebate Programs:** Manufacturer rebate tracking

---

## Replication Priority Matrix

| Module | Priority | Complexity | Notes |
|--------|----------|------------|-------|
| Dashboard | High | Medium | Stats + activity feed |
| Clients | High | High | Central entity with many relations |
| Leads | High | Medium | List + Kanban, tags, convert to client |
| Tasks | High | High | Timers, checklists, comments |
| Batch | High | High | Core pharmacy workflow |
| Temp Batch | High | High | Staging + error handling |
| Transactions (Import) | High | Medium | CSV import with validation |
| Rebates | High | Medium | CSV import + tracking |
| Refills | High | Medium | Next fill date management |
| Brokers | High | Low | Simple CRUD + support numbers |
| Companies | High | Low | Simple CRUD |
| Products | Medium | Low | Drug catalog |
| Invoices | Medium | High | Line items, PDF, payments |
| Contracts | Medium | Medium | Linked to clients |
| Tickets | Medium | High | Department routing, replies |
| SMS Landing Page | Medium | Low | Bilingual message templates |
| Address Verification | Medium | Low | Date logic + reminders |
| Escalations | Medium | Medium | Workflow tracking |
| Workgroups | Low | Low | Staff grouping |
| Subscriptions | Low | Medium | Recurring billing |
| Knowledge Base | Low | Low | Articles + categories |
| Reports | Low | High | Defer until data is mature |
| Estimates/Proposals | Low | Medium | Financial docs |
| Expenses | Low | Low | Simple tracking |

---

## Recommended Tech Stack for Replication

- **Frontend:** HTML + Tailwind CSS + Alpine.js (or vanilla JS)
- **Backend:** .NET 8 minimal API or Node/Netlify Functions
- **Database:** SQL Server (existing `virtuallwell` DB)
- **Auth:** Session-based or JWT
- **File storage:** Azure Blob or local
- **PDF generation:** Puppeteer or a .NET PDF library
- **CSV import:** Papa Parse (frontend) or server-side streaming
