var BSSOpportunity = (function () {

    // ============================================================
    // CREATE QUOTE FROM OPPORTUNITY SUBGRID
    // ============================================================

    async function createQuoteFromOpportunity(primaryControl, selectedControl) {
     
        var progressShown = false;

        try {
            // 1. Resolve Opportunity Form Context
            var oppFormContext = null;

            if (primaryControl) {
                if (typeof primaryControl.getAttribute === "function") {
                    oppFormContext = primaryControl;
                } else if (typeof primaryControl.getFormContext === "function") {
                    oppFormContext = primaryControl.getFormContext();
                }
            }

            if (!oppFormContext && selectedControl) {
                if (typeof selectedControl.getFormContext === "function") {
                    oppFormContext = selectedControl.getFormContext();
                } else if (typeof selectedControl.getAttribute === "function") {
                    oppFormContext = selectedControl;
                }
            }

            if (!oppFormContext && typeof Xrm !== "undefined" && Xrm.Page && Xrm.Page.data) {
                oppFormContext = Xrm.Page;
            }

            if (!oppFormContext || !oppFormContext.data || !oppFormContext.data.entity) {
                throw new Error("Opportunity Form context not found.");
            }

            if (oppFormContext.data.entity.getIsDirty()) {
                await oppFormContext.data.save();
            }

            var oppId = oppFormContext.data.entity.getId().replace(/[{}]/g, "");

            Xrm.Utility.showProgressIndicator("Creating Quote & mapping customer...");
            progressShown = true;

            function getVal(attrName) {
                var attr = oppFormContext.getAttribute(attrName);
                return attr ? attr.getValue() : null;
            }

            // ----------------------------------------------------
            // 2. Fetch Account through Contact (bss_parentcustomerid)
            // ----------------------------------------------------
            var customerId = null;
            var customerName = null;
            var customerTarget = "bss_accounts"; // Verified Custom Account Table

            var contactVal = getVal("bss_contact");
            if (contactVal && contactVal.length > 0) {
                var contactId = contactVal[0].id.replace(/[{}]/g, "");
                try {
                    // Contact se bss_parentcustomerid (Account lookup) fetch karein
                    var contactRec = await Xrm.WebApi.retrieveRecord(
                        "contact", 
                        contactId, 
                        "?$select=_bss_parentcustomerid_value"
                    );

                    if (contactRec && contactRec._bss_parentcustomerid_value) {
                        customerId = contactRec._bss_parentcustomerid_value.replace(/[{}]/g, "");
                        customerName = contactRec["_bss_parentcustomerid_value@OData.Community.Display.V1.FormattedValue"] || "Account";
                        customerTarget = "bss_accounts";
                    }
                } catch (cErr) {
                    // Agar contact lookup alag table par ho
                    try {
                        var cRec2 = await Xrm.WebApi.retrieveRecord("contact", contactId, "?$select=_parentcustomerid_value");
                        if (cRec2 && cRec2._parentcustomerid_value) {
                            customerId = cRec2._parentcustomerid_value.replace(/[{}]/g, "");
                            customerName = cRec2["_parentcustomerid_value@OData.Community.Display.V1.FormattedValue"] || "Account";
                            customerTarget = "bss_accounts";
                        }
                    } catch (e2) {
                        console.warn("Contact account fetch fallback:", e2);
                    }
                }
            }

            // Fallback: Opportunity Header Account
            if (!customerId) {
                var headerAcc = getVal("bss_account") || getVal("parentaccountid");
                if (headerAcc && headerAcc.length > 0) {
                    customerId = headerAcc[0].id.replace(/[{}]/g, "");
                    customerName = headerAcc[0].name;
                    customerTarget = "bss_accounts";
                }
            }

            // ----------------------------------------------------
            // 3. Build Quote Payload
            // ----------------------------------------------------
            var topic = getVal("bss_topic");
            var quotePayload = {
                "bss_quotename": topic ? topic : "Quote from Opportunity",
                "bss_status": 760820000,
                "bss_statusreason": 1
            };

            if (getVal("bss_description")) quotePayload["bss_description"] = getVal("bss_description");
            if (getVal("bss_totallineitemamount") !== null) quotePayload["bss_totallineitemamount"] = Number(getVal("bss_totallineitemamount"));
            if (getVal("bss_totalamount") !== null) quotePayload["bss_totalamount"] = Number(getVal("bss_totalamount"));
            if (getVal("bss_totaltaxamount") !== null) quotePayload["bss_totaltax"] = Number(getVal("bss_totaltaxamount"));
            if (getVal("bss_totalamountlessfreight") !== null) quotePayload["bss_totalamountlessfreight"] = Number(getVal("bss_totalamountlessfreight"));
            if (getVal("bss_freightamount") !== null) quotePayload["bss_freightamount"] = Number(getVal("bss_freightamount"));
            if (getVal("bss_discountpercentage") !== null) quotePayload["bss_quotediscount"] = Number(getVal("bss_discountpercentage"));
            if (getVal("bss_totaldiscountamount") !== null) quotePayload["bss_quotediscountamount"] = Number(getVal("bss_totaldiscountamount"));

            // Opportunity Link
            quotePayload["bss_opportunity@odata.bind"] = "/bss_opportunities(" + oppId + ")";

            // Price List Link
            var priceList = getVal("bss_pricelevelid");
            if (priceList && priceList.length > 0) {
                quotePayload["bss_pricelevelid@odata.bind"] = "/bss_pricelists(" + priceList[0].id.replace(/[{}]/g, "") + ")";
            }

            // Bind Potential Customer using verified bss_accounts
            if (customerId) {
                quotePayload["bss_potentialcustomerid_bss_accounts@odata.bind"] = "/bss_accountses(" + customerId + ")";
            }

            var createdQuote = null;
            try {
                createdQuote = await Xrm.WebApi.createRecord("bss_quote", quotePayload);
            } catch (createErr) {
                // Secondary fallback binding
                delete quotePayload["bss_potentialcustomerid_bss_accounts@odata.bind"];
                if (customerId) {
                    quotePayload["bss_potentialcustomerid@odata.bind"] = "/bss_accountses(" + customerId + ")";
                }
                try {
                    createdQuote = await Xrm.WebApi.createRecord("bss_quote", quotePayload);
                } catch (createErr2) {
                    delete quotePayload["bss_potentialcustomerid@odata.bind"];
                    createdQuote = await Xrm.WebApi.createRecord("bss_quote", quotePayload);
                }
            }

            var newQuoteId = createdQuote.id.replace(/[{}]/g, "");

            // ----------------------------------------------------
            // 4. Copy Opportunity Products to Quote Products
            // ----------------------------------------------------
            var oppProducts = [];
            try {
                var query = "?$filter=_bss_opportunity_value eq " + oppId;
                var res = await Xrm.WebApi.retrieveMultipleRecords("bss_opportunityproduct", query);
                if (res && res.entities && res.entities.length > 0) {
                    oppProducts = res.entities;
                }
            } catch (fetchErr) {
                var allLines = await Xrm.WebApi.retrieveMultipleRecords("bss_opportunityproduct", "");
                if (allLines && allLines.entities) {
                    oppProducts = allLines.entities.filter(function (l) {
                        for (var k in l) {
                            if (typeof l[k] === "string" && l[k].toLowerCase().indexOf(oppId.toLowerCase()) !== -1) {
                                return true;
                            }
                        }
                        return false;
                    });
                }
            }

            if (oppProducts.length > 0) {
                for (var i = 0; i < oppProducts.length; i++) {
                    var item = oppProducts[i];
                    var linePayload = {
                        "bss_quote@odata.bind": "/bss_quotes(" + newQuoteId + ")",
                        "bss_quantity": item.bss_quantity ? Number(item.bss_quantity) : 1,
                        "bss_priceperunit": item.bss_priceperunit ? Number(item.bss_priceperunit) : 0
                    };

                    if (item.bss_extendedamount !== null && item.bss_extendedamount !== undefined) {
                        linePayload["bss_extendedamount"] = Number(item.bss_extendedamount);
                    }
                    if (item.bss_manualdiscount !== null && item.bss_manualdiscount !== undefined) {
                        linePayload["bss_manualdiscount"] = Number(item.bss_manualdiscount);
                    }
                    if (item.bss_tax !== null && item.bss_tax !== undefined) {
                        linePayload["bss_tax"] = Number(item.bss_tax);
                    }

                    var pId = item._bss_productname_value || item._bss_productid_value;
                    if (pId) {
                        linePayload["bss_productname@odata.bind"] = "/bss_products(" + pId.replace(/[{}]/g, "") + ")";
                    }

                    var uId = item._bss_unit_value;
                    if (uId) {
                        linePayload["bss_unit@odata.bind"] = "/bss_units(" + uId.replace(/[{}]/g, "") + ")";
                    }

                    try {
                        await Xrm.WebApi.createRecord("bss_quoteproduct", linePayload);
                    } catch (lErr) {
                        console.error("Failed to copy product line:", lErr);
                    }
                }
            }

            if (progressShown) {
                Xrm.Utility.closeProgressIndicator();
                progressShown = false;
            }

            // ----------------------------------------------------
            // 5. Open Saved Quote Record Directly
            // ----------------------------------------------------
            // Note: formParams se type 'account' pass nahi karenge, 
            // taaki CRM save par relationship mismatch crash na ho.
            var formParams = {};
            if (customerId) {
                formParams["bss_potentialcustomerid"] = "{" + customerId + "}";
                formParams["bss_potentialcustomeridname"] = customerName || "Bit";
                formParams["bss_potentialcustomeridtype"] = "bss_accounts"; // Explicit custom entity!
            }

            await Xrm.Navigation.openForm({
                entityName: "bss_quote",
                entityId: newQuoteId,
                useQuickCreateForm: false
            }, formParams);

        } catch (error) {
            if (progressShown) {
                Xrm.Utility.closeProgressIndicator();
            }
            console.error("CREATE QUOTE ERROR:", error);
            await Xrm.Navigation.openErrorDialog({
                title: "Create Quote Failed",
                message: error.message || "Failed to create Quote."
            });
        }
    }

    return {
        createQuoteFromOpportunity: createQuoteFromOpportunity
    };

})();