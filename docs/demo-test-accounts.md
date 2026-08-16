# Demo test accounts

`pnpm seed:demo:remote` creates an isolated tenant named **Go Digital Demo Motors (Test Only)**. All accounts use the password stored in the ignored local `.env` variable `DEMO_TEST_PASSWORD`.

| Role                          | Test email                                              |
| ----------------------------- | ------------------------------------------------------- |
| Super Admin                   | `super-admin@demo.go-digital.invalid`                   |
| Business Owner                | `business-owner@demo.go-digital.invalid`                |
| Client Admin                  | `client-admin@demo.go-digital.invalid`                  |
| System Administrator          | `system-administrator@demo.go-digital.invalid`          |
| GM Sales Executive            | `gm-sales@demo.go-digital.invalid`                      |
| Showroom Manager              | `showroom-manager@demo.go-digital.invalid`              |
| Team Manager                  | `team-manager@demo.go-digital.invalid`                  |
| Team Manager 2                | `team-manager-2@demo.go-digital.invalid`                |
| Team Manager 3                | `team-manager-3@demo.go-digital.invalid`                |
| Sales Consultant              | `sales-consultant@demo.go-digital.invalid`              |
| Sales Consultant 2            | `sales-consultant-2@demo.go-digital.invalid`            |
| Sales Consultant 3            | `sales-consultant-3@demo.go-digital.invalid`            |
| Sales Consultant 4            | `sales-consultant-4@demo.go-digital.invalid`            |
| Sales Consultant 5            | `sales-consultant-5@demo.go-digital.invalid`            |
| Sales Consultant 6            | `sales-consultant-6@demo.go-digital.invalid`            |
| Sales Consultant 7            | `sales-consultant-7@demo.go-digital.invalid`            |
| Telecaller / BDC Executive    | `telecaller-bdc@demo.go-digital.invalid`                |
| Telecaller / BDC Executive 2  | `telecaller-bdc-2@demo.go-digital.invalid`              |
| Telecaller / BDC Executive 3  | `telecaller-bdc-3@demo.go-digital.invalid`              |
| Telecaller / BDC Executive 4  | `telecaller-bdc-4@demo.go-digital.invalid`              |
| Inventory Manager             | `inventory-manager@demo.go-digital.invalid`             |
| Finance Manager               | `finance-manager@demo.go-digital.invalid`               |
| Insurance Manager             | `insurance-manager@demo.go-digital.invalid`             |
| RTO Manager                   | `rto-manager@demo.go-digital.invalid`                   |
| Used Car / Exchange Manager   | `exchange-manager@demo.go-digital.invalid`              |
| Delivery Manager              | `delivery-manager@demo.go-digital.invalid`              |
| Customer Relationship Manager | `customer-relationship-manager@demo.go-digital.invalid` |
| Digital Marketing Manager     | `digital-marketing-manager@demo.go-digital.invalid`     |

Privileged accounts still require TOTP MFA by product policy: Super Admin, Business Owner, Client Admin, System Administrator and GM Sales Executive. The other demo roles can sign in with their email and the local test password.

Never reuse this test password or these accounts for real dealership users.
