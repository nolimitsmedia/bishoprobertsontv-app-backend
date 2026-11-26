// server-api/lib/builtinPages.js
//
// Starting content for the Contact, Terms and Conditions and Privacy Policy
// pages, so they can be edited in Admin › Pages (visual editor). Added once by
// routes/adminPages.js › seedBuiltinPages(); after that the pages belong to the
// admin. If a page is unpublished or deleted, the site shows its built-in
// version instead (admin-panel/src/pages/public/ContactPage.js, LegalPage.js).
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let n = 0;
const id = (p) => `bi-${p}-${(++n).toString(36)}`;
const section = (title, blocks, styles = {}) => ({
  id: id("sec"),
  title,
  layout: "plain",
  theme: "default",
  styles: { show_title: false, ...styles },
  blocks,
});
const heading = (text, level = "h2") => ({
  id: id("h"),
  type: "heading",
  text,
  level,
  link: "",
});
const rich = (html) => ({ id: id("t"), type: "richtext", html });
const spacer = (height = 16) => ({
  id: id("sp"),
  type: "spacer",
  height,
  divider: false,
});
const columns2 = (left, right) => ({
  id: id("cols"),
  type: "columns",
  gap: 28,
  stack_on_mobile: true,
  align_items: "start",
  columns: [
    { id: id("c"), width_pct: 42, styles: {}, blocks: left },
    { id: id("c"), width_pct: 58, styles: {}, blocks: right },
  ],
});

const CONTACT = {
  email: "info@bishoprobertson.tv", // placeholder until the client confirms
  phone: "804-675-7600",
  address: ["2501 Mt Gilead Blvd", "Richmond, Virginia 23235"],
  hours: "Monday – Friday, 9:00 AM – 5:00 PM ET", // placeholder
};

function contactPage() {
  const tel = CONTACT.phone.replace(/[^0-9+]/g, "");
  return {
    extra_sections: [
      section(
        "Intro",
        [
          heading("Contact", "h1"),
          rich(
            "<p>Questions about your membership, a message, or the live services? Send us a note.</p>",
          ),
        ],
        { align: "left" },
      ),
      section(
        "Details and form",
        [
          columns2(
            [
              rich(
                `<h3>Email</h3><p><a href="mailto:${esc(CONTACT.email)}">${esc(CONTACT.email)}</a></p>` +
                  `<h3>Phone</h3><p><a href="tel:${esc(tel)}">${esc(CONTACT.phone)}</a><br>${esc(CONTACT.hours)}</p>` +
                  `<h3>Address</h3><p>${CONTACT.address.map(esc).join("<br>")}</p>`,
              ),
            ],
            [
              {
                id: "contact-form",
                type: "form",
                title: "Send us a message",
                submit_text: "Send message",
                notify_email: "",
                success_message: "Thank you! We’ll get back to you soon.",
                fields: [
                  { id: "name", label: "Name", type: "text", required: true },
                  {
                    id: "email",
                    label: "Email",
                    type: "email",
                    required: true,
                  },
                  {
                    id: "phone",
                    label: "Phone",
                    type: "phone",
                    required: false,
                  },
                  {
                    id: "message",
                    label: "Message",
                    type: "textarea",
                    required: true,
                  },
                ],
              },
            ],
          ),
        ],
        { align: "left" },
      ),
    ],
  };
}

const OWNER = "[Legal name of the ministry or company]";
const STATE = "[State, e.g. Virginia]";
// Filled with the ministry's name (Site Settings › Brand) when the pages are
// first created — see fillSiteName in routes/adminPages.js (Phase 2C).
const SITE = "{{SITE_NAME}}";

const TERMS = [
  [
    "About these terms",
    [
      `These Terms and Conditions (“Terms”) govern your use of ${SITE}, its website, apps and live services (the “Service”), operated by ${OWNER} (“we”, “us”). By creating an account or using the Service you agree to these Terms. If you do not agree, please do not use the Service.`,
    ],
  ],
  [
    "Your account",
    [
      "You must provide accurate information and keep your password secure. You are responsible for activity on your account. Tell us promptly if you believe your account has been used without your permission.",
      "You must be at least 13 years old to create an account. If you are under the age of majority where you live, a parent or guardian must agree to these Terms for you.",
    ],
  ],
  [
    "Free accounts, memberships and payments",
    [
      "Some content is free; other content is for members or requires a paid membership or purchase. Prices, what is included and the billing period are shown before you buy.",
      "Paid memberships renew automatically at the end of each billing period until you cancel. You can cancel at any time in your account; cancellation takes effect at the end of the current period and you keep access until then. Except where the law requires otherwise, payments are not refundable.",
      "Payments are processed by our payment provider (Stripe). We do not store your full card details. We may change prices with notice; changes apply from your next billing period.",
    ],
  ],
  [
    "Using the content",
    [
      "Messages, videos, live services, music, artwork and other content on the Service belong to us or our licensors and are protected by copyright and other laws.",
      "We give you a personal, non-transferable, non-exclusive permission to watch the content for your own, non-commercial use through the Service. You may not copy, download (except where we offer a download), record, re-broadcast, resell, publicly show or share the content, or share your account or password, or try to get around access controls or content protection.",
    ],
  ],
  [
    "Community, comments and live chat",
    [
      "You are responsible for what you post. Be respectful. Do not post anything unlawful, hateful, harassing, sexually explicit, misleading, spam or advertising, or anything that infringes someone else’s rights or shares their private information.",
      "By posting you give us permission to display your post on the Service. We may remove posts and suspend or close accounts that break these rules, at our discretion.",
    ],
  ],
  [
    "Live services and availability",
    [
      "We aim to keep the Service available, but it may sometimes be unavailable, interrupted or changed, including live services, which depend on third-party providers. Content may be added or removed over time.",
    ],
  ],
  [
    "Ending your use",
    [
      "You may stop using the Service and close your account at any time. We may suspend or end your access if you break these Terms or if we stop providing the Service. Sections that by their nature should continue (for example ownership of content, limits of liability) continue after your access ends.",
    ],
  ],
  [
    "Disclaimers and limitation of liability",
    [
      "The Service is provided “as is” and “as available”, without warranties of any kind to the fullest extent allowed by law. Teaching and other content is for spiritual and general information and is not professional (for example medical, legal or financial) advice.",
      `To the fullest extent allowed by law, ${OWNER} is not liable for indirect, incidental, special or consequential damages, and our total liability for any claim relating to the Service is limited to the amount you paid us in the 12 months before the claim.`,
    ],
  ],
  [
    "Governing law",
    [
      `These Terms are governed by the laws of ${STATE}, United States, without regard to its conflict of law rules.`,
    ],
  ],
  [
    "Changes to these terms",
    [
      "We may update these Terms. If the changes are significant we will tell you (for example by email or a notice on the Service). Continuing to use the Service after the changes take effect means you accept them.",
    ],
  ],
];
const PRIVACY = [
  [
    "About this policy",
    [
      `This Privacy Policy explains what personal information ${OWNER} (“we”, “us”) collects when you use ${SITE} (the “Service”), how we use it and the choices you have.`,
    ],
  ],
  [
    "Information we collect",
    [
      "Account information: your name, email address, password (stored securely, never in plain text) and profile picture if you add one.",
      "Membership and payment information: your membership, purchases and billing history. Card payments are handled by Stripe; we do not receive or store your full card number.",
      "Viewing activity: what you watch, where you stopped (so you can resume), your My List and playlists, and reminders you set for live services.",
      "Things you post: comments, community posts and live chat messages, and messages you send us through the contact form.",
      "Technical information: device and browser type, IP address, pages viewed and similar log data, and information stored in your browser (cookies and local storage) to keep you signed in and remember your preferences.",
    ],
  ],
  [
    "How we use it",
    [
      "To provide the Service: your account, streaming, resuming where you left off, memberships and purchases.",
      "To communicate with you: account and billing emails, reminders you asked for (for example “Notify me” for a live service) and, if you agreed, news about new messages and events. You can unsubscribe from non-essential emails at any time.",
      "To keep the Service safe and working: preventing fraud and abuse, moderating posts, fixing problems and understanding how the Service is used so we can improve it.",
      "To meet legal obligations.",
    ],
  ],
  [
    "Who we share it with",
    [
      "We do not sell your personal information. We share it only with service providers that help us run the Service, under agreements to protect it: video delivery (Bunny.net), payments (Stripe), hosting and databases, file storage, and email delivery; and when required by law or to protect our rights and users’ safety.",
    ],
  ],
  [
    "How long we keep it",
    [
      "We keep your information while your account is open and as long as needed for the purposes above, including legal, tax and accounting requirements. When you close your account we delete or anonymize your information within a reasonable time, except where we must keep it.",
    ],
  ],
  [
    "Your choices and rights",
    [
      "You can view and update your account details in your account. You can ask us for a copy of your information, to correct it or to delete your account by contacting us (details below). Depending on where you live you may have additional rights under local law, which we will respect.",
      "You can control cookies in your browser settings; blocking them may stop you staying signed in.",
    ],
  ],
  [
    "Children",
    [
      "The Service is not directed to children under 13 and we do not knowingly collect their personal information. If you believe a child has given us information, contact us and we will delete it.",
    ],
  ],
  [
    "Security",
    [
      "We use reasonable technical and organizational measures to protect your information, such as encrypted connections and secure password storage. No method of transmission or storage is completely secure.",
    ],
  ],
  [
    "Changes to this policy",
    [
      "We may update this policy. If the changes are significant we will tell you, for example by email or a notice on the Service.",
    ],
  ],
];

function legalPage(title, intro, parts, contactLine) {
  const body =
    parts
      .map(
        ([h, paras]) =>
          `<h2>${esc(h)}</h2>${paras.map((p) => `<p>${esc(p)}</p>`).join("")}`,
      )
      .join("") +
    `<h2>Contact us</h2><p>${contactLine} Email <a href="mailto:${esc(CONTACT.email)}">${esc(CONTACT.email)}</a> or use our <a href="#/contact">contact page</a>.</p>`;
  return {
    extra_sections: [
      section(
        "Intro",
        [
          rich("<p><strong>LAST UPDATED: NOVEMBER 2026</strong></p>"),
          heading(title, "h1"),
          rich(`<p>${esc(intro)}</p>`),
          spacer(8),
        ],
        { align: "left", max_width: "780px" },
      ),
      // a comfortable reading width; both settings can be changed in the editor
      section("Text", [rich(body)], { align: "left", max_width: "780px" }),
    ],
  };
}

const BUILTIN_PAGES = [
  { slug: "contact", title: "Contact", content: contactPage },
  {
    slug: "terms",
    title: "Terms and Conditions",
    content: () =>
      legalPage(
        "Terms and Conditions",
        "Please read these terms before using {{SITE_NAME}}.",
        TERMS,
        "Questions about this agreement?",
      ),
  },
  {
    slug: "privacy",
    title: "Privacy Policy",
    content: () =>
      legalPage(
        "Privacy Policy",
        "How we collect, use and protect your information.",
        PRIVACY,
        "Questions about this policy?",
      ),
  },
];

module.exports = { BUILTIN_PAGES };
