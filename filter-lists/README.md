# Filter lists

The `fetch-lists` workflow downloads the upstream lists into this directory. The generated copies are committed so builds are reproducible and do not depend on network access during the conversion step.

Sources currently configured:

- EasyList — advertising filters: <https://easylist.to/>
- EasyPrivacy — tracking and analytics filters: <https://easylist.to/>
- uBlock Origin filters — general network and cosmetic filters: <https://github.com/uBlockOrigin/uAssets>
- uBlock Origin Other Annoyances — nuisance and cosmetic filters: <https://github.com/uBlockOrigin/uAssets>
- uBlock Origin Cookie Notices — cookie notice filters: <https://github.com/uBlockOrigin/uAssets>
- uBlock Origin Quick Fixes — targeted compatibility fixes: <https://github.com/uBlockOrigin/uAssets>
- uBlock Origin Unbreak — site-compatibility exceptions: <https://github.com/uBlockOrigin/uAssets>

These lists are maintained by their respective communities and are not authored by WeBlock. Their contents and licensing terms remain with their upstream maintainers. Review the upstream project licenses before redistributing modified list content. WeBlock's own source code is licensed separately under the repository license.
